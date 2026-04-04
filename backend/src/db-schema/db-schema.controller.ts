import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DataSource } from 'typeorm';

@Controller('db-schema')
@UseGuards(JwtAuthGuard)
export class DbSchemaController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async getSchema() {
    // Get all tables
    const tables: { table_name: string }[] = await this.dataSource.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    // Get all columns
    const columns: {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }[] = await this.dataSource.query(`
      SELECT table_name, column_name, data_type, is_nullable,
             column_default, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    // Get foreign keys
    const foreignKeys: {
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
      constraint_name: string;
    }[] = await this.dataSource.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name
    `);

    // Get primary keys
    const primaryKeys: {
      table_name: string;
      column_name: string;
    }[] = await this.dataSource.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
    `);

    // Get row counts
    const rowCounts: { table_name: string; count: string }[] = await this.dataSource.query(`
      SELECT relname AS table_name, n_live_tup::text AS count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY relname
    `);

    const pkMap = new Map<string, Set<string>>();
    for (const pk of primaryKeys) {
      if (!pkMap.has(pk.table_name)) pkMap.set(pk.table_name, new Set());
      pkMap.get(pk.table_name)!.add(pk.column_name);
    }

    const countMap = new Map<string, number>();
    for (const rc of rowCounts) {
      countMap.set(rc.table_name, parseInt(rc.count, 10));
    }

    // Build table name set and snake_case lookup for logical relation detection
    const tableNames = new Set(tables.map((t) => t.table_name));
    // Map: camelCase suffix → table name (e.g. "organizationId" → "organizations", "userId" → "users")
    const camelToTable = new Map<string, string>();
    for (const name of tableNames) {
      // users → userId, organizations → organizationId, call_sessions → callSessionId
      const camel = name
        .replace(/_([a-z])/g, (_, c) => c.toUpperCase()) // snake to camel
        .replace(/s$/, ''); // remove trailing 's'
      camelToTable.set(camel + 'Id', name);
      // Also try without removing 's' for tables like "user_status"
      const camelFull = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      camelToTable.set(camelFull + 'Id', name);
    }

    // Build set of existing FK columns per table for dedup
    const existingFks = new Set<string>();
    for (const fk of foreignKeys) {
      existingFks.add(`${fk.table_name}:${fk.column_name}`);
    }

    // Build structured response
    const schema = tables.map((t) => {
      const tableCols = columns.filter((c) => c.table_name === t.table_name);
      const tableFks = foreignKeys.filter((fk) => fk.table_name === t.table_name);
      const pks = pkMap.get(t.table_name) || new Set();

      // Detect logical relations: columns ending in Id that match a table name
      const logicalRelations: { column: string; referencesTable: string; referencesColumn: string }[] = [];
      for (const col of tableCols) {
        // Skip columns that already have a real FK
        if (existingFks.has(`${t.table_name}:${col.column_name}`)) continue;
        // Skip primary keys
        if (pks.has(col.column_name)) continue;

        // Check camelCase columns like "organizationId"
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
        rowCount: countMap.get(t.table_name) || 0,
        columns: tableCols.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default,
          maxLength: c.character_maximum_length,
          isPrimaryKey: pks.has(c.column_name),
          isForeignKey: tableFks.some((fk) => fk.column_name === c.column_name),
          isLogicalFk: logicalRelations.some((lr) => lr.column === c.column_name),
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
