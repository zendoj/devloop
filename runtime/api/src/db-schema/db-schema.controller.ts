import {
  Controller,
  Get,
  Inject,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';
import { SessionGuard } from '../auth/guards/session.guard';

/**
 * DB schema introspection (moved from dev_energicrm Fas E).
 *
 * Read-only dump of the devloop DB's public schema, used by the
 * web UI at /db-schema to render an ER diagram + table list.
 * Unlike the original dev_energicrm version, this controller
 * does NOT expose an add-column mutation — devloop's DB is
 * migration-managed and must never be mutated from the web UI.
 *
 * Auth: SessionGuard (same shape as /api/tasks).
 */

interface TableRow {
  table_name: string;
}
interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}
interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  constraint_name: string;
}
interface PrimaryKeyRow {
  table_name: string;
  column_name: string;
}
interface RowCountRow {
  table_name: string;
  count: string;
}

interface SchemaResponse {
  tables: Array<{
    name: string;
    rowCount: number;
    columns: Array<{
      name: string;
      type: string;
      nullable: boolean;
      default: string | null;
      maxLength: number | null;
      isPrimaryKey: boolean;
      isForeignKey: boolean;
      isLogicalFk: boolean;
    }>;
    foreignKeys: Array<{
      column: string;
      referencesTable: string;
      referencesColumn: string;
      constraintName: string;
    }>;
    logicalRelations: Array<{
      column: string;
      referencesTable: string;
      referencesColumn: string;
    }>;
  }>;
  totalTables: number;
}

@Controller('api/db-schema')
@UseGuards(SessionGuard)
export class DbSchemaController {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  @Get()
  public async getSchema(): Promise<SchemaResponse> {
    const tables = (await this.ds.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)) as TableRow[];

    const columns = (await this.ds.query(`
      SELECT table_name, column_name, data_type, is_nullable,
             column_default, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `)) as ColumnRow[];

    const foreignKeys = (await this.ds.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name  AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema    = 'public'
      ORDER BY tc.table_name
    `)) as ForeignKeyRow[];

    const primaryKeys = (await this.ds.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema    = 'public'
    `)) as PrimaryKeyRow[];

    const rowCounts = (await this.ds.query(`
      SELECT relname AS table_name, n_live_tup::text AS count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY relname
    `)) as RowCountRow[];

    const pkMap = new Map<string, Set<string>>();
    for (const pk of primaryKeys) {
      if (!pkMap.has(pk.table_name)) pkMap.set(pk.table_name, new Set());
      pkMap.get(pk.table_name)!.add(pk.column_name);
    }

    const countMap = new Map<string, number>();
    for (const rc of rowCounts) {
      countMap.set(rc.table_name, parseInt(rc.count, 10));
    }

    // Build camelCase → table-name lookup so we can detect
    // "logical" relations (columns named like projectId that
    // point at projects.id without a real FK constraint).
    const tableNames = new Set(tables.map((t) => t.table_name));
    const camelToTable = new Map<string, string>();
    for (const name of tableNames) {
      const camel = name
        .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
        .replace(/s$/, '');
      camelToTable.set(camel + 'Id', name);
      const camelFull = name.replace(
        /_([a-z])/g,
        (_, c: string) => c.toUpperCase(),
      );
      camelToTable.set(camelFull + 'Id', name);
    }

    const existingFks = new Set<string>();
    for (const fk of foreignKeys) {
      existingFks.add(`${fk.table_name}:${fk.column_name}`);
    }

    const schema = tables.map((t) => {
      const tableCols = columns.filter((c) => c.table_name === t.table_name);
      const tableFks = foreignKeys.filter((fk) => fk.table_name === t.table_name);
      const pks = pkMap.get(t.table_name) ?? new Set<string>();

      const logicalRelations: Array<{
        column: string;
        referencesTable: string;
        referencesColumn: string;
      }> = [];
      for (const col of tableCols) {
        if (existingFks.has(`${t.table_name}:${col.column_name}`)) continue;
        if (pks.has(col.column_name)) continue;
        const matchedTable = camelToTable.get(col.column_name);
        if (matchedTable && matchedTable !== t.table_name) {
          logicalRelations.push({
            column: col.column_name,
            referencesTable: matchedTable,
            referencesColumn: 'id',
          });
        }
      }

      return {
        name: t.table_name,
        rowCount: countMap.get(t.table_name) ?? 0,
        columns: tableCols.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default,
          maxLength: c.character_maximum_length,
          isPrimaryKey: pks.has(c.column_name),
          isForeignKey: tableFks.some((fk) => fk.column_name === c.column_name),
          isLogicalFk: logicalRelations.some(
            (lr) => lr.column === c.column_name,
          ),
        })),
        foreignKeys: tableFks.map((fk) => ({
          column: fk.column_name,
          referencesTable: fk.foreign_table_name,
          referencesColumn: fk.foreign_column_name,
          constraintName: fk.constraint_name,
        })),
        logicalRelations,
      };
    });

    return { tables: schema, totalTables: schema.length };
  }
}
