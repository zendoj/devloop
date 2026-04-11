'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Key, Link2, Database, Search, Table2, GitBranch, List, AlertTriangle, Move, RotateCcw } from 'lucide-react';

// Ported from dev_energicrm Fas E. Uses native fetch to avoid
// pulling @tanstack/react-query + axios into devloop web.
async function fetchSchema(): Promise<SchemaResponse> {
  const res = await fetch('/api/db-schema', { credentials: 'include' });
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    throw new Error(`db-schema fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as SchemaResponse;
}

type Column = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  maxLength: number | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isLogicalFk?: boolean;
};

type ForeignKey = {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  constraintName: string;
};

type LogicalRelation = {
  column: string;
  referencesTable: string;
  referencesColumn: string;
};

type TableInfo = {
  name: string;
  rowCount: number;
  columns: Column[];
  foreignKeys: ForeignKey[];
  logicalRelations?: LogicalRelation[];
};

type SchemaResponse = {
  tables: TableInfo[];
  totalTables: number;
};

const TYPE_COLORS: Record<string, string> = {
  uuid: '#8b5cf6',
  integer: '#2563eb',
  bigint: '#2563eb',
  smallint: '#2563eb',
  numeric: '#2563eb',
  'double precision': '#2563eb',
  real: '#2563eb',
  'character varying': '#d97706',
  text: '#d97706',
  boolean: '#059669',
  'timestamp without time zone': '#dc2626',
  'timestamp with time zone': '#dc2626',
  date: '#dc2626',
  jsonb: '#9333ea',
  json: '#9333ea',
  ARRAY: '#0891b2',
};

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] || '#6b7280';
}

function shortType(col: Column): string {
  let t = col.type;
  if (t === 'character varying') t = col.maxLength ? `varchar(${col.maxLength})` : 'varchar';
  if (t === 'timestamp without time zone') t = 'timestamp';
  if (t === 'timestamp with time zone') t = 'timestamptz';
  if (t === 'double precision') t = 'double';
  if (t === 'ARRAY') t = 'array';
  return t;
}

/* ─── List View: TableCard ─── */

function TableCard({
  table,
  allTables,
  onNavigate,
  defaultExpanded,
}: {
  table: TableInfo;
  allTables: TableInfo[];
  onNavigate: (name: string) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || false);

  useEffect(() => {
    if (defaultExpanded !== undefined) setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  const incomingRefs = useMemo(() => {
    const refs: { fromTable: string; fromColumn: string; toColumn: string }[] = [];
    for (const t of allTables) {
      for (const fk of t.foreignKeys) {
        if (fk.referencesTable === table.name) {
          refs.push({ fromTable: t.name, fromColumn: fk.column, toColumn: fk.referencesColumn });
        }
      }
    }
    return refs;
  }, [table.name, allTables]);

  // Incoming logical relations (other tables have logicalRelation pointing here)
  const incomingLogical = useMemo(() => {
    const refs: { fromTable: string; fromColumn: string; toColumn: string }[] = [];
    for (const t of allTables) {
      for (const lr of t.logicalRelations || []) {
        if (lr.referencesTable === table.name) {
          refs.push({ fromTable: t.name, fromColumn: lr.column, toColumn: lr.referencesColumn });
        }
      }
    }
    return refs;
  }, [table.name, allTables]);

  const logicalRels = table.logicalRelations || [];
  const hasRelations = table.foreignKeys.length > 0 || incomingRefs.length > 0 || logicalRels.length > 0 || incomingLogical.length > 0;

  return (
    <div style={{
      background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb',
      overflow: 'hidden', boxShadow: expanded ? '0 4px 20px rgba(0,0,0,0.08)' : 'none',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          cursor: 'pointer', userSelect: 'none',
          background: expanded ? '#f8fafc' : '#fff',
          borderBottom: expanded ? '1px solid #e5e7eb' : 'none',
        }}
      >
        {expanded ? <ChevronDown size={16} color="#6b7280" /> : <ChevronRight size={16} color="#6b7280" />}
        <Table2 size={16} color="#3b82f6" />
        <span style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', fontFamily: 'monospace' }}>{table.name}</span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{table.columns.length} kolumner</span>
        <span style={{ fontSize: 12, color: '#6b7280', background: '#f3f4f6', padding: '1px 8px', borderRadius: 10 }}>{table.rowCount} rader</span>
        {hasRelations && (
          <span style={{ fontSize: 11, color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 2 }}>
            <Link2 size={12} /> {table.foreignKeys.length + incomingRefs.length}
          </span>
        )}
      </div>

      {expanded && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f1f5f9' }}>
                <th style={{ textAlign: 'left', padding: '6px 16px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Kolumn</th>
                <th style={{ textAlign: 'left', padding: '6px 12px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Typ</th>
                <th style={{ textAlign: 'center', padding: '6px 12px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Null</th>
                <th style={{ textAlign: 'left', padding: '6px 12px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Default</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((col) => (
                <tr key={col.name} style={{
                  borderBottom: '1px solid #f1f5f9',
                  background: col.isPrimaryKey ? '#fffbeb' : col.isForeignKey ? '#eff6ff' : col.isLogicalFk ? '#fff7ed' : '#fff',
                }}>
                  <td style={{ padding: '5px 16px', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {col.isPrimaryKey && <Key size={12} color="#d97706" />}
                    {col.isForeignKey && <Link2 size={12} color="#2563eb" />}
                    {col.isLogicalFk && !col.isForeignKey && <AlertTriangle size={12} color="#d97706" />}
                    <span style={{ fontWeight: col.isPrimaryKey ? 700 : 400 }}>{col.name}</span>
                  </td>
                  <td style={{ padding: '5px 12px' }}>
                    <span style={{
                      fontFamily: 'monospace', fontSize: 12,
                      color: getTypeColor(col.type), background: getTypeColor(col.type) + '10',
                      padding: '1px 6px', borderRadius: 4,
                    }}>{shortType(col)}</span>
                  </td>
                  <td style={{ padding: '5px 12px', textAlign: 'center', color: col.nullable ? '#9ca3af' : '#dc2626', fontSize: 12 }}>
                    {col.nullable ? 'yes' : 'no'}
                  </td>
                  <td style={{ padding: '5px 12px', fontFamily: 'monospace', fontSize: 11, color: '#6b7280', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {col.default || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {hasRelations && (
            <div style={{ padding: '16px 16px 20px', borderTop: '1px solid #e5e7eb', background: '#f8fafc' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <GitBranch size={14} /> Relationer
              </div>

              {/* Tree: current table as root */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {/* Root node */}
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: '#1e293b', color: '#fff', padding: '6px 14px',
                  borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: 'monospace',
                  alignSelf: 'flex-start',
                }}>
                  <Table2 size={14} /> {table.name}
                </div>

                {/* Outgoing FK branches */}
                {table.foreignKeys.map((fk, i) => (
                  <div key={fk.constraintName} style={{ marginLeft: 20, position: 'relative' }}>
                    {/* Vertical + horizontal connector line */}
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: i < table.foreignKeys.length - 1 || incomingRefs.length > 0 ? 0 : '50%',
                      width: 1, background: '#cbd5e1',
                    }} />
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      padding: '8px 0',
                    }}>
                      {/* Horizontal connector */}
                      <div style={{ width: 24, height: 1, background: '#cbd5e1', flexShrink: 0 }} />
                      {/* Arrow */}
                      <div style={{ color: '#2563eb', fontSize: 14, flexShrink: 0, marginRight: 4 }}>&#9654;</div>
                      {/* Card */}
                      <button onClick={() => onNavigate(fk.referencesTable)} style={{
                        display: 'flex', flexDirection: 'column', gap: 2,
                        background: '#fff', border: '2px solid #bfdbfe', borderRadius: 8,
                        padding: '8px 14px', cursor: 'pointer', textAlign: 'left',
                        transition: 'border-color 0.15s, box-shadow 0.15s',
                      }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2563eb'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(37,99,235,0.15)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#bfdbfe'; e.currentTarget.style.boxShadow = 'none'; }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#1e293b' }}>
                          {fk.referencesTable}
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
                          <span style={{ color: '#2563eb' }}>{fk.column}</span>
                          <span style={{ color: '#9ca3af', margin: '0 4px' }}>&#8594;</span>
                          <span style={{ color: '#059669' }}>{fk.referencesColumn}</span>
                        </div>
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>
                          Denna tabell pekar hit
                        </div>
                      </button>
                    </div>
                  </div>
                ))}

                {/* Incoming ref branches */}
                {incomingRefs.length > 0 && (
                  <div style={{ marginLeft: 20, position: 'relative' }}>
                    {/* Section label */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      padding: '10px 0 4px',
                    }}>
                      <div style={{ width: 24, height: 1, background: '#e9d5ff', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: '#9333ea', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginLeft: 8 }}>
                        Refereras av
                      </span>
                    </div>

                    {incomingRefs.map((ref, i) => (
                      <div key={i} style={{ marginLeft: 0, position: 'relative' }}>
                        <div style={{
                          position: 'absolute', left: 0, top: 0, bottom: i < incomingRefs.length - 1 ? 0 : '50%',
                          width: 1, background: '#e9d5ff',
                        }} />
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 0,
                          padding: '6px 0',
                        }}>
                          <div style={{ width: 24, height: 1, background: '#e9d5ff', flexShrink: 0 }} />
                          <div style={{ color: '#9333ea', fontSize: 14, flexShrink: 0, marginRight: 4 }}>&#9664;</div>
                          <button onClick={() => onNavigate(ref.fromTable)} style={{
                            display: 'flex', flexDirection: 'column', gap: 2,
                            background: '#fff', border: '2px solid #e9d5ff', borderRadius: 8,
                            padding: '8px 14px', cursor: 'pointer', textAlign: 'left',
                            transition: 'border-color 0.15s, box-shadow 0.15s',
                          }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#9333ea'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(147,51,234,0.15)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e9d5ff'; e.currentTarget.style.boxShadow = 'none'; }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#1e293b' }}>
                              {ref.fromTable}
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
                              <span style={{ color: '#9333ea' }}>{ref.fromColumn}</span>
                              <span style={{ color: '#9ca3af', margin: '0 4px' }}>&#8594;</span>
                              <span style={{ color: '#059669' }}>{ref.toColumn}</span>
                            </div>
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>
                              Pekar till denna tabell
                            </div>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Logical outgoing relations (no FK constraint) */}
                {logicalRels.length > 0 && (
                  <div style={{ marginLeft: 20, position: 'relative' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      padding: '10px 0 4px',
                    }}>
                      <div style={{ width: 24, height: 1, background: '#fed7aa', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: '#d97706', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={10} /> Logiska relationer (ingen FK-constraint)
                      </span>
                    </div>

                    {logicalRels.map((lr, i) => (
                      <div key={`lr-${i}`} style={{ marginLeft: 0, position: 'relative' }}>
                        <div style={{
                          position: 'absolute', left: 0, top: 0, bottom: i < logicalRels.length - 1 ? 0 : '50%',
                          width: 1, background: '#fed7aa',
                        }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '6px 0' }}>
                          <div style={{ width: 24, height: 1, background: '#fed7aa', flexShrink: 0 }} />
                          <div style={{ color: '#d97706', fontSize: 14, flexShrink: 0, marginRight: 4 }}>&#9654;</div>
                          <button onClick={() => onNavigate(lr.referencesTable)} style={{
                            display: 'flex', flexDirection: 'column', gap: 2,
                            background: '#fff', border: '2px dashed #fed7aa', borderRadius: 8,
                            padding: '8px 14px', cursor: 'pointer', textAlign: 'left',
                            transition: 'border-color 0.15s',
                          }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#d97706'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#fed7aa'; }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#1e293b' }}>
                              {lr.referencesTable}
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
                              <span style={{ color: '#d97706' }}>{lr.column}</span>
                              <span style={{ color: '#9ca3af', margin: '0 4px' }}>&#8594;</span>
                              <span style={{ color: '#059669' }}>{lr.referencesColumn}</span>
                            </div>
                            <div style={{ fontSize: 10, color: '#d97706', marginTop: 1, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <AlertTriangle size={9} /> Ingen FK-constraint i DB
                            </div>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Incoming logical relations */}
                {incomingLogical.length > 0 && (
                  <div style={{ marginLeft: 20, position: 'relative' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      padding: '10px 0 4px',
                    }}>
                      <div style={{ width: 24, height: 1, background: '#fed7aa', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: '#d97706', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={10} /> Refereras logiskt av (ingen FK)
                      </span>
                    </div>

                    {incomingLogical.map((ref, i) => (
                      <div key={`ilr-${i}`} style={{ marginLeft: 0, position: 'relative' }}>
                        <div style={{
                          position: 'absolute', left: 0, top: 0, bottom: i < incomingLogical.length - 1 ? 0 : '50%',
                          width: 1, background: '#fed7aa',
                        }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '6px 0' }}>
                          <div style={{ width: 24, height: 1, background: '#fed7aa', flexShrink: 0 }} />
                          <div style={{ color: '#d97706', fontSize: 14, flexShrink: 0, marginRight: 4 }}>&#9664;</div>
                          <button onClick={() => onNavigate(ref.fromTable)} style={{
                            display: 'flex', flexDirection: 'column', gap: 2,
                            background: '#fff', border: '2px dashed #fed7aa', borderRadius: 8,
                            padding: '8px 14px', cursor: 'pointer', textAlign: 'left',
                            transition: 'border-color 0.15s',
                          }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#d97706'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#fed7aa'; }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#1e293b' }}>
                              {ref.fromTable}
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
                              <span style={{ color: '#d97706' }}>{ref.fromColumn}</span>
                              <span style={{ color: '#9ca3af', margin: '0 4px' }}>&#8594;</span>
                              <span style={{ color: '#059669' }}>{ref.toColumn}</span>
                            </div>
                            <div style={{ fontSize: 10, color: '#d97706', marginTop: 1, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <AlertTriangle size={9} /> Ingen FK-constraint i DB
                            </div>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Diagram View: Field-to-Field Relation Explorer ─── */

type FieldRef = { table: string; column: string; el: HTMLDivElement };

function DiagramTableCard({
  table, isCenter, onClick, fieldRefs, side,
}: {
  table: TableInfo;
  isCenter?: boolean;
  onClick?: () => void;
  fieldRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  side: 'left' | 'center' | 'right';
}) {
  const pkCols = table.columns.filter((c) => c.isPrimaryKey);
  const fkCols = table.columns.filter((c) => c.isForeignKey && !c.isPrimaryKey);
  const logicalCols = table.columns.filter((c) => c.isLogicalFk && !c.isForeignKey && !c.isPrimaryKey);
  const otherCols = table.columns.filter((c) => !c.isPrimaryKey && !c.isForeignKey && !c.isLogicalFk);
  const maxShow = isCenter ? 30 : 8;
  const shown = [...pkCols, ...fkCols, ...logicalCols, ...otherCols].slice(0, maxShow);
  const remaining = table.columns.length - shown.length;

  const setRef = useCallback((colName: string, el: HTMLDivElement | null) => {
    const key = `${table.name}:${colName}`;
    if (el) fieldRefs.current.set(key, el);
    else fieldRefs.current.delete(key);
  }, [table.name, fieldRefs]);

  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff', borderRadius: 10,
        border: isCenter ? '2px solid #2563eb' : '1px solid #d1d5db',
        boxShadow: isCenter ? '0 0 0 4px rgba(37,99,235,0.1), 0 8px 24px rgba(0,0,0,0.1)' : '0 2px 8px rgba(0,0,0,0.06)',
        overflow: 'hidden', cursor: onClick ? 'pointer' : 'default',
        width: isCenter ? 280 : 220, flexShrink: 0,
      }}
      onMouseEnter={(e) => { if (!isCenter && onClick) e.currentTarget.style.borderColor = '#93c5fd'; }}
      onMouseLeave={(e) => { if (!isCenter && onClick) e.currentTarget.style.borderColor = '#d1d5db'; }}
    >
      <div style={{
        background: isCenter ? '#1e40af' : '#1e293b', color: '#fff',
        padding: isCenter ? '10px 14px' : '7px 12px',
        fontSize: isCenter ? 14 : 12, fontWeight: 700, fontFamily: 'monospace',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>{table.name}</span>
        <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.18)', padding: '2px 8px', borderRadius: 8 }}>{table.rowCount}</span>
      </div>
      {shown.map((col) => {
        const isPK = col.isPrimaryKey;
        const isFK = col.isForeignKey;
        const isLogical = col.isLogicalFk && !isFK;
        return (
          <div
            key={col.name}
            ref={(el) => setRef(col.name, el)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: isCenter ? '4px 14px' : '3px 10px',
              fontSize: isCenter ? 12 : 11, fontFamily: 'monospace',
              borderBottom: '1px solid #f1f5f9',
              background: isPK ? '#fffbeb' : isFK ? '#eff6ff' : isLogical ? '#fff7ed' : '#fff',
            }}
          >
            {isPK && <Key size={11} color="#d97706" style={{ flexShrink: 0 }} />}
            {isFK && !isPK && <Link2 size={11} color="#2563eb" style={{ flexShrink: 0 }} />}
            {isLogical && <AlertTriangle size={11} color="#d97706" style={{ flexShrink: 0 }} />}
            {!isPK && !isFK && !isLogical && <span style={{ width: 11, flexShrink: 0 }} />}
            <span style={{ fontWeight: isPK ? 700 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {col.name}
            </span>
            <span style={{ fontSize: 9, color: getTypeColor(col.type), flexShrink: 0 }}>{shortType(col)}</span>
          </div>
        );
      })}
      {remaining > 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10, color: '#94a3b8', textAlign: 'center', background: '#fafafa' }}>+{remaining} fält</div>
      )}
    </div>
  );
}

// Old MiniTableCard kept for compatibility but unused
function MiniTableCard({ table, isCenter, onClick }: { table: TableInfo; isCenter?: boolean; onClick?: () => void }) {
  const pkCols = table.columns.filter((c) => c.isPrimaryKey);
  const fkCols = table.columns.filter((c) => c.isForeignKey && !c.isPrimaryKey);
  const otherCols = table.columns.filter((c) => !c.isPrimaryKey && !c.isForeignKey);
  const maxShow = isCenter ? 20 : 6;
  const shown = [...pkCols, ...fkCols, ...otherCols].slice(0, maxShow);
  const remaining = table.columns.length - shown.length;

  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        borderRadius: 10,
        border: isCenter ? '2px solid #2563eb' : '1px solid #d1d5db',
        boxShadow: isCenter
          ? '0 0 0 4px rgba(37,99,235,0.12), 0 8px 24px rgba(0,0,0,0.1)'
          : '0 2px 8px rgba(0,0,0,0.06)',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        width: isCenter ? 280 : 220,
        flexShrink: 0,
        transition: 'box-shadow 0.2s, border-color 0.2s',
      }}
      onMouseEnter={(e) => { if (!isCenter) e.currentTarget.style.borderColor = '#93c5fd'; }}
      onMouseLeave={(e) => { if (!isCenter) e.currentTarget.style.borderColor = '#d1d5db'; }}
    >
      <div style={{
        background: isCenter ? '#1e40af' : '#1e293b',
        color: '#fff', padding: isCenter ? '10px 14px' : '7px 12px',
        fontSize: isCenter ? 14 : 12, fontWeight: 700, fontFamily: 'monospace',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>{table.name}</span>
        <span style={{
          fontSize: 10, background: 'rgba(255,255,255,0.18)',
          padding: '2px 8px', borderRadius: 8,
        }}>{table.rowCount} rader</span>
      </div>
      {shown.map((col) => {
        const isPK = col.isPrimaryKey;
        const isFK = col.isForeignKey;
        return (
          <div key={col.name} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: isCenter ? '4px 14px' : '3px 10px',
            fontSize: isCenter ? 12 : 11, fontFamily: 'monospace',
            borderBottom: '1px solid #f1f5f9',
            background: isPK ? '#fffbeb' : isFK ? '#eff6ff' : '#fff',
          }}>
            {isPK && <Key size={11} color="#d97706" style={{ flexShrink: 0 }} />}
            {isFK && !isPK && <Link2 size={11} color="#2563eb" style={{ flexShrink: 0 }} />}
            {!isPK && !isFK && <span style={{ width: 11, flexShrink: 0 }} />}
            <span style={{
              fontWeight: isPK ? 700 : 400, flex: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{col.name}</span>
            <span style={{ fontSize: 9, color: getTypeColor(col.type), flexShrink: 0 }}>
              {shortType(col)}
            </span>
          </div>
        );
      })}
      {remaining > 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10, color: '#94a3b8', textAlign: 'center', background: '#fafafa' }}>
          +{remaining} fält till
        </div>
      )}
    </div>
  );
}

function RelationArrow({ direction, fields, relationType, nullable, isLogical }: {
  direction: 'left' | 'right';
  fields: { from: string; to: string }[];
  relationType: string;
  nullable: boolean;
  isLogical?: boolean;
}) {
  const isLeft = direction === 'left';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 2, minWidth: 120, padding: '0 4px',
    }}>
      {/* Relation type badge */}
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: isLogical ? '#d97706' : '#6b7280',
        background: isLogical ? '#fff7ed' : '#f1f5f9',
        padding: '2px 8px', borderRadius: 6,
        border: `1px ${isLogical ? 'dashed' : 'solid'} ${isLogical ? '#fed7aa' : '#e2e8f0'}`,
        display: 'flex', alignItems: 'center', gap: 3,
      }}>
        {isLogical && <AlertTriangle size={9} />}
        {relationType}
      </div>
      {/* Arrow line with SVG */}
      <svg width={120} height={30} style={{ overflow: 'visible' }}>
        {(() => {
          const color = isLogical ? '#d97706' : nullable ? '#94a3b8' : '#3b82f6';
          const dash = isLogical ? '4 4' : nullable ? '5 3' : 'none';
          return (
            <>
              <line x1={0} y1={15} x2={120} y2={15} stroke={color} strokeWidth={2} strokeDasharray={dash} />
              {isLeft ? (
                <>
                  <line x1={0} y1={8} x2={14} y2={15} stroke={color} strokeWidth={1.5} />
                  <line x1={0} y1={22} x2={14} y2={15} stroke={color} strokeWidth={1.5} />
                  <line x1={0} y1={8} x2={0} y2={22} stroke={color} strokeWidth={1.5} />
                  <line x1={112} y1={8} x2={112} y2={22} stroke={color} strokeWidth={1.5} />
                  <polygon points="120,15 110,10 110,20" fill={color} />
                </>
              ) : (
                <>
                  <line x1={8} y1={8} x2={8} y2={22} stroke={color} strokeWidth={1.5} />
                  <polygon points="0,15 10,10 10,20" fill={color} />
                  <line x1={120} y1={8} x2={106} y2={15} stroke={color} strokeWidth={1.5} />
                  <line x1={120} y1={22} x2={106} y2={15} stroke={color} strokeWidth={1.5} />
                  <line x1={120} y1={8} x2={120} y2={22} stroke={color} strokeWidth={1.5} />
                </>
              )}
            </>
          );
        })()}
      </svg>
      {/* Field mappings */}
      {fields.map((f, i) => (
        <div key={i} style={{
          fontSize: 10, fontFamily: 'monospace', color: '#475569',
          background: '#fff', padding: '2px 8px', borderRadius: 4,
          border: '1px solid #e2e8f0', whiteSpace: 'nowrap',
        }}>
          <span style={{ color: '#2563eb' }}>{f.from}</span>
          <span style={{ color: '#94a3b8', margin: '0 3px' }}>→</span>
          <span style={{ color: '#059669' }}>{f.to}</span>
        </div>
      ))}
      {nullable && (
        <div style={{ fontSize: 9, color: '#94a3b8', fontStyle: 'italic' }}>valfri (nullable)</div>
      )}
    </div>
  );
}

const STORAGE_KEY = 'db-diagram-positions';
const DETAIL_LEVELS_KEY = 'db-diagram-detail-levels';
const CARD_W = 240;
const CARD_HEADER_H = 34;
const CARD_ROW_H = 22;

type DetailLevel = 1 | 2 | 3;
const DETAIL_CYCLE: DetailLevel[] = [2, 1, 3]; // 10 → 20 → kopplingar

function loadDetailLevels(): Record<string, DetailLevel> {
  try {
    const raw = localStorage.getItem(DETAIL_LEVELS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDetailLevels(levels: Record<string, DetailLevel>) {
  localStorage.setItem(DETAIL_LEVELS_KEY, JSON.stringify(levels));
}

function loadPositions(): Record<string, Record<string, { x: number; y: number }>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePositions(focusTable: string, positions: Record<string, { x: number; y: number }>) {
  const all = loadPositions();
  all[focusTable] = positions;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function autoLayout(
  centerName: string,
  relatedNames: string[],
  canvasW: number,
  canvasH: number,
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const cx = Math.max(canvasW / 2 - CARD_W / 2, 60);
  const cy = Math.max(canvasH / 2 - 100, 40);
  positions[centerName] = { x: cx, y: cy };

  const count = relatedNames.length;
  if (count === 0) return positions;

  const radius = Math.max(280, Math.min(count * 50, 500));
  const startAngle = -Math.PI / 2;
  relatedNames.forEach((name, i) => {
    const angle = startAngle + (2 * Math.PI * i) / count;
    positions[name] = {
      x: cx + Math.cos(angle) * radius,
      y: Math.max(16, cy + Math.sin(angle) * radius),
    };
  });
  // Ensure center is also not too high
  positions[centerName] = { x: cx, y: Math.max(16, cy) };
  return positions;
}

type RelEdge = {
  fromTable: string; fromCol: string;
  toTable: string; toCol: string;
  isLogical: boolean; nullable: boolean;
};

function getConnectionFields(table: TableInfo, allEdges: RelEdge[]): Column[] {
  const connColNames = new Set<string>();
  for (const e of allEdges) {
    if (e.fromTable === table.name) connColNames.add(e.fromCol);
    if (e.toTable === table.name) connColNames.add(e.toCol);
  }
  return table.columns.filter((c) => connColNames.has(c.name));
}

function DraggableCard({
  table, x, y, isCenter, isFocused, isMultiSelected, onMouseDown, onClick, detailLevel, allEdges, onCycleDetail,
}: {
  table: TableInfo; x: number; y: number; isCenter: boolean; isFocused: boolean; isMultiSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: () => void;
  detailLevel: DetailLevel;
  allEdges: RelEdge[];
  onCycleDetail: () => void;
}) {
  const pkCols = table.columns.filter((c) => c.isPrimaryKey);
  const fkCols = table.columns.filter((c) => c.isForeignKey && !c.isPrimaryKey);
  const logCols = table.columns.filter((c) => c.isLogicalFk && !c.isForeignKey && !c.isPrimaryKey);
  const otherCols = table.columns.filter((c) => !c.isPrimaryKey && !c.isForeignKey && !c.isLogicalFk);
  const allOrdered = [...pkCols, ...fkCols, ...logCols, ...otherCols];

  let shownCols: Column[];
  let maxVisible: number;
  let hasScroll = false;

  if (detailLevel === 3) {
    // Only connection fields
    shownCols = getConnectionFields(table, allEdges);
    maxVisible = shownCols.length;
  } else {
    maxVisible = detailLevel === 1 ? 20 : 10;
    shownCols = allOrdered.slice(0, maxVisible);
    hasScroll = allOrdered.length > maxVisible;
  }

  const scrollHeight = detailLevel === 3 ? undefined : maxVisible * CARD_ROW_H;

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        position: 'absolute', left: x, top: y, width: CARD_W,
        background: '#fff', borderRadius: 10,
        border: isCenter ? '2px solid #2563eb' : isMultiSelected ? '2px solid #8b5cf6' : '1px solid #d1d5db',
        boxShadow: isCenter
          ? '0 0 0 4px rgba(37,99,235,0.12), 0 8px 24px rgba(0,0,0,0.12)'
          : isMultiSelected ? '0 0 0 3px rgba(139,92,246,0.2), 0 4px 12px rgba(0,0,0,0.1)'
          : '0 2px 8px rgba(0,0,0,0.08)',
        cursor: 'grab', userSelect: 'none',
        zIndex: isFocused ? 8 : isCenter ? 5 : 2,
        transition: 'box-shadow 0.15s',
      }}
    >
      <div style={{
        background: isCenter ? '#1e40af' : '#1e293b', color: '#fff',
        padding: '7px 12px', fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderRadius: '9px 9px 0 0',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, overflow: 'hidden' }}>
          <Move size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{table.name}</span>
        </span>
        <span
          onClick={(e) => { e.stopPropagation(); onCycleDetail(); }}
          onMouseDown={(e) => e.stopPropagation()}
          title="Växla detaljnivå"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: '50%',
            background: 'rgba(255,255,255,0.2)', cursor: 'pointer', flexShrink: 0, marginLeft: 4,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.45)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
        >
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
            <rect x={0} y={0} width={10} height={2} rx={1} fill="#fff" opacity={detailLevel === 1 ? 1 : 0.4} />
            <rect x={0} y={4} width={10} height={2} rx={1} fill="#fff" opacity={detailLevel >= 2 ? 0.7 : 0.4} />
            <rect x={0} y={8} width={7} height={2} rx={1} fill="#fff" opacity={detailLevel === 3 ? 1 : 0.3} />
          </svg>
        </span>
        <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.18)', padding: '1px 7px', borderRadius: 8, flexShrink: 0, marginLeft: 4 }}>
          {table.rowCount}
        </span>
      </div>
      <div style={{
        maxHeight: hasScroll ? scrollHeight : undefined,
        overflowY: hasScroll ? 'auto' : undefined,
      }}>
        {(detailLevel === 3 ? shownCols : shownCols).map((col) => {
          const isPK = col.isPrimaryKey;
          const isFK = col.isForeignKey;
          const isLog = col.isLogicalFk && !isFK;
          return (
            <div key={col.name} data-field={`${table.name}:${col.name}`} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '2px 10px', height: CARD_ROW_H,
              fontSize: 11, fontFamily: 'monospace',
              borderBottom: '1px solid #f1f5f9',
              background: isPK ? '#fffbeb' : isFK ? '#eff6ff' : isLog ? '#fff7ed' : '#fff',
            }}>
              {isPK && <Key size={10} color="#d97706" style={{ flexShrink: 0 }} />}
              {isFK && !isPK && <Link2 size={10} color="#2563eb" style={{ flexShrink: 0 }} />}
              {isLog && <AlertTriangle size={10} color="#d97706" style={{ flexShrink: 0 }} />}
              {!isPK && !isFK && !isLog && <span style={{ width: 10, flexShrink: 0 }} />}
              <span style={{ fontWeight: isPK ? 700 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {col.name}
              </span>
              <span style={{ fontSize: 9, color: getTypeColor(col.type), flexShrink: 0 }}>{shortType(col)}</span>
            </div>
          );
        })}
      </div>
      {hasScroll && allOrdered.length > maxVisible && (
        <div style={{ padding: '3px 10px', fontSize: 10, color: '#94a3b8', textAlign: 'center', background: '#fafafa', borderRadius: '0 0 9px 9px' }}>
          ↕ scrolla · {allOrdered.length} fält totalt
        </div>
      )}
    </div>
  );
}

function RelationDiagram({ tables, initialTable, onTableChange }: { tables: TableInfo[]; initialTable?: string | null; onTableChange?: (name: string | null) => void }) {
  const [selected, setSelectedRaw] = useState<string | null>(initialTable || null);
  const setSelected = useCallback((name: string | null) => {
    setSelectedRaw(name);
    setMultiSelected(new Set());
    onTableChange?.(name);
  }, [onTableChange]);
  const tableMap = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<{ names: string[]; startX: number; startY: number; origPositions: Record<string, { x: number; y: number }> } | null>(null);
  const didDragRef = useRef(false);
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const [detailLevels, setDetailLevels] = useState<Record<string, DetailLevel>>(loadDetailLevels);

  const getDetailLevel = useCallback((name: string): DetailLevel => detailLevels[name] || 2, [detailLevels]);

  const cycleDetailLevel = useCallback((name: string) => {
    setDetailLevels((prev) => {
      const current = prev[name] || 2;
      const idx = DETAIL_CYCLE.indexOf(current);
      const next = DETAIL_CYCLE[(idx + 1) % DETAIL_CYCLE.length] as DetailLevel;
      const updated: Record<string, DetailLevel> = { ...prev, [name]: next };
      saveDetailLevels(updated);
      return updated;
    });
  }, []);

  const tablesWithRelations = useMemo(() => {
    const names = new Set<string>();
    for (const t of tables) {
      if (t.foreignKeys.length > 0 || (t.logicalRelations && t.logicalRelations.length > 0)) {
        names.add(t.name);
        for (const fk of t.foreignKeys) names.add(fk.referencesTable);
        for (const lr of t.logicalRelations || []) names.add(lr.referencesTable);
      }
    }
    return tables.filter((t) => names.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  }, [tables]);

  // Build edges for the selected table
  const edges = useMemo<RelEdge[]>(() => {
    if (!selected) return [];
    const result: RelEdge[] = [];
    const selTable = tableMap.get(selected);
    if (!selTable) return [];

    for (const fk of selTable.foreignKeys) {
      const col = selTable.columns.find((c) => c.name === fk.column);
      result.push({
        fromTable: selected, fromCol: fk.column,
        toTable: fk.referencesTable, toCol: fk.referencesColumn,
        isLogical: false, nullable: col?.nullable || false,
      });
    }
    for (const lr of selTable.logicalRelations || []) {
      const col = selTable.columns.find((c) => c.name === lr.column);
      result.push({
        fromTable: selected, fromCol: lr.column,
        toTable: lr.referencesTable, toCol: lr.referencesColumn,
        isLogical: true, nullable: col?.nullable || false,
      });
    }
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (fk.referencesTable === selected) {
          const col = t.columns.find((c) => c.name === fk.column);
          result.push({
            fromTable: t.name, fromCol: fk.column,
            toTable: selected, toCol: fk.referencesColumn,
            isLogical: false, nullable: col?.nullable || false,
          });
        }
      }
      for (const lr of t.logicalRelations || []) {
        if (lr.referencesTable === selected) {
          const col = t.columns.find((c) => c.name === lr.column);
          result.push({
            fromTable: t.name, fromCol: lr.column,
            toTable: selected, toCol: lr.referencesColumn,
            isLogical: true, nullable: col?.nullable || false,
          });
        }
      }
    }
    return result;
  }, [selected, tables, tableMap]);

  // Visible table names = selected + all related
  const visibleNames = useMemo(() => {
    if (!selected) return [];
    const names = new Set<string>([selected]);
    for (const e of edges) { names.add(e.fromTable); names.add(e.toTable); }
    return Array.from(names);
  }, [selected, edges]);

  // Initialize positions when selection changes
  useEffect(() => {
    if (!selected || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const saved = loadPositions()[selected];
    const relatedNames = visibleNames.filter((n) => n !== selected);

    if (saved && Object.keys(saved).length > 0) {
      // Merge: use saved positions, auto-layout for any new tables
      const auto = autoLayout(selected, relatedNames, rect.width, rect.height);
      const merged = { ...auto, ...saved };
      setPositions(merged);
    } else {
      setPositions(autoLayout(selected, relatedNames, rect.width, rect.height));
    }
  }, [selected, visibleNames.length]);

  // Drag handlers
  const handleMouseDown = useCallback((name: string, e: React.MouseEvent) => {
    e.preventDefault();
    const pos = positions[name];
    if (!pos) return;

    // Shift+click toggles multi-select
    if (e.shiftKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      return;
    }

    // Determine which cards to drag: if clicked card is in multi-select, drag all selected
    const dragNames = multiSelected.has(name) && multiSelected.size > 1
      ? Array.from(multiSelected)
      : [name];

    const origPositions: Record<string, { x: number; y: number }> = {};
    for (const n of dragNames) {
      if (positions[n]) origPositions[n] = { ...positions[n] };
    }

    dragRef.current = { names: dragNames, startX: e.clientX, startY: e.clientY, origPositions };
    didDragRef.current = false;
    setFocusedCard(name);
  }, [positions, multiSelected]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true;
      setPositions((prev) => {
        const next = { ...prev };
        for (const name of d.names) {
          const orig = d.origPositions[name];
          if (orig) next[name] = { x: orig.x + dx, y: Math.max(0, orig.y + dy) };
        }
        return next;
      });
    };
    const handleMouseUp = () => {
      if (dragRef.current && didDragRef.current && selected) {
        setPositions((prev) => {
          savePositions(selected, prev);
          return prev;
        });
      }
      dragRef.current = null;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); };
  }, [selected]);

  const resetLayout = useCallback(() => {
    if (!selected || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const relatedNames = visibleNames.filter((n) => n !== selected);
    const fresh = autoLayout(selected, relatedNames, rect.width, rect.height);
    setPositions(fresh);
    savePositions(selected, fresh);
  }, [selected, visibleNames]);

  // Compute field Y-offset within a card
  const fieldYOffset = useCallback((tableName: string, colName: string): number => {
    const t = tableMap.get(tableName);
    if (!t) return CARD_HEADER_H;
    const lvl = getDetailLevel(tableName);

    if (lvl === 3) {
      const connFields = getConnectionFields(t, edges);
      const idx = connFields.findIndex((c) => c.name === colName);
      if (idx === -1) return CARD_HEADER_H + (connFields.length * CARD_ROW_H) / 2;
      return CARD_HEADER_H + idx * CARD_ROW_H + CARD_ROW_H / 2;
    }

    const pkCols = t.columns.filter((c) => c.isPrimaryKey);
    const fkCols = t.columns.filter((c) => c.isForeignKey && !c.isPrimaryKey);
    const logCols = t.columns.filter((c) => c.isLogicalFk && !c.isForeignKey && !c.isPrimaryKey);
    const otherCols = t.columns.filter((c) => !c.isPrimaryKey && !c.isForeignKey && !c.isLogicalFk);
    const ordered = [...pkCols, ...fkCols, ...logCols, ...otherCols];
    const maxVisible = lvl === 1 ? 20 : 10;
    const idx = ordered.findIndex((c) => c.name === colName);
    if (idx === -1 || idx >= maxVisible) return CARD_HEADER_H + (maxVisible * CARD_ROW_H) / 2;
    return CARD_HEADER_H + idx * CARD_ROW_H + CARD_ROW_H / 2;
  }, [tableMap, getDetailLevel, edges]);

  // Build SVG arrows
  const arrows = useMemo(() => {
    return edges.map((edge) => {
      const fromPos = positions[edge.fromTable];
      const toPos = positions[edge.toTable];
      if (!fromPos || !toPos) return null;

      const fromCx = fromPos.x + CARD_W / 2;
      const toCx = toPos.x + CARD_W / 2;
      const fromFieldY = fromPos.y + fieldYOffset(edge.fromTable, edge.fromCol);
      const toFieldY = toPos.y + fieldYOffset(edge.toTable, edge.toCol);

      let x1: number, y1: number, x2: number, y2: number;
      if (fromCx < toCx) {
        x1 = fromPos.x + CARD_W;
        x2 = toPos.x;
      } else {
        x1 = fromPos.x;
        x2 = toPos.x + CARD_W;
      }
      y1 = fromFieldY;
      y2 = toFieldY;

      const dx = Math.abs(x2 - x1);
      const cp = Math.max(dx * 0.4, 40);
      const cx1 = x1 < x2 ? x1 + cp : x1 - cp;
      const cx2 = x1 < x2 ? x2 - cp : x2 + cp;
      const path = `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;

      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;

      return { ...edge, x1, y1, x2, y2, path, midX, midY };
    }).filter(Boolean) as (RelEdge & { x1: number; y1: number; x2: number; y2: number; path: string; midX: number; midY: number })[];
  }, [edges, positions, fieldYOffset]);

  const totalOut = edges.filter((e) => e.fromTable === selected).length;
  const totalIn = edges.filter((e) => e.toTable === selected).length;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Controls — compact single row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 16px',
        background: '#fff', borderBottom: '1px solid #e2e8f0', flexShrink: 0,
      }}>
        <select
          value={selected || ''}
          onChange={(e) => setSelected(e.target.value || null)}
          style={{
            padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db',
            fontSize: 12, fontFamily: 'monospace', background: '#fff', minWidth: 180,
          }}
        >
          <option value="">— Välj tabell —</option>
          {tablesWithRelations.map((t) => {
            const lr = t.logicalRelations?.length || 0;
            return (
              <option key={t.name} value={t.name}>{t.name} ({t.foreignKeys.length} FK{lr > 0 ? `+${lr}` : ''}, {t.rowCount})</option>
            );
          })}
        </select>
        {selected && (
          <>
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {totalOut}↑ {totalIn}↓
            </span>
            <button onClick={resetLayout} style={{
              display: 'flex', alignItems: 'center', gap: 3,
              padding: '3px 8px', borderRadius: 5, border: '1px solid #d1d5db',
              background: '#fff', fontSize: 11, color: '#374151', cursor: 'pointer',
            }}>
              <RotateCcw size={10} /> Återställ
            </button>
          </>
        )}
        {selected && (
          <div style={{ fontSize: 10, color: '#94a3b8', marginLeft: 'auto' }}>
            Dra · Dubbelklicka = fokus
          </div>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: 'auto', background: '#f8fafc', position: 'relative', minHeight: 400 }}
      >
        {!selected && (
          <div style={{ textAlign: 'center', padding: '80px 24px', color: '#94a3b8' }}>
            <GitBranch size={48} style={{ marginBottom: 16, opacity: 0.4 }} />
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Välj en tabell ovan</div>
            <div style={{ fontSize: 13 }}>Se alla relationer — dra tabeller fritt och positionerna sparas</div>
          </div>
        )}

        {selected && (
          <>
            {/* SVG arrows layer */}
            <svg style={{
              position: 'absolute', top: 0, left: 0,
              width: '100%', height: '100%', minWidth: 1200, minHeight: 800,
              pointerEvents: 'none', zIndex: 3,
            }}>
              {arrows.map((a, i) => {
                const color = a.isLogical ? '#d97706' : a.nullable ? '#94a3b8' : '#3b82f6';
                const dash = a.isLogical ? '5 4' : a.nullable ? '6 3' : 'none';
                return (
                  <g key={i}>
                    <path d={a.path} stroke={color} strokeWidth={2} fill="none" strokeDasharray={dash} />
                    <circle cx={a.x1} cy={a.y1} r={3} fill={color} />
                    <circle cx={a.x2} cy={a.y2} r={3} fill={color} />
                  </g>
                );
              })}
            </svg>

            {/* Draggable table cards */}
            {visibleNames.map((name) => {
              const t = tableMap.get(name);
              const pos = positions[name];
              if (!t || !pos) return null;
              return (
                <DraggableCard
                  key={name}
                  table={t}
                  x={pos.x}
                  y={pos.y}
                  isCenter={name === selected}
                  isFocused={name === focusedCard}
                  isMultiSelected={multiSelected.has(name)}
                  onMouseDown={(e) => handleMouseDown(name, e)}
                  onClick={() => { if (!didDragRef.current) setSelected(name); }}
                  detailLevel={getDetailLevel(name)}
                  allEdges={edges}
                  onCycleDetail={() => cycleDetailLevel(name)}
                />
              );
            })}

            {/* Legend */}
            <div style={{
              position: 'sticky', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              display: 'inline-flex', gap: 16, justifyContent: 'center',
              padding: '8px 20px', background: '#fff', borderRadius: 10,
              border: '1px solid #e2e8f0', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              zIndex: 10, width: 'fit-content', margin: '0 auto',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b' }}>
                <svg width={24} height={10}><line x1={0} y1={5} x2={24} y2={5} stroke="#3b82f6" strokeWidth={2} /></svg>
                FK
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b' }}>
                <svg width={24} height={10}><line x1={0} y1={5} x2={24} y2={5} stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 3" /></svg>
                Nullable
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#d97706' }}>
                <svg width={24} height={10}><line x1={0} y1={5} x2={24} y2={5} stroke="#d97706" strokeWidth={2} strokeDasharray="4 4" /></svg>
                Logisk
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Main Page ─── */

function useUrlState() {
  const getParams = useCallback(() => {
    if (typeof window === 'undefined') return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);

  const setParam = useCallback((key: string, value: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState({}, '', url);
  }, []);

  return { getParams, setParam };
}

export default function DbPage() {
  const { getParams, setParam } = useUrlState();

  // Read initial state from URL
  const initParams = useMemo(() => getParams(), []);
  const initView = (initParams.get('vy') === 'relationer' ? 'diagram' : initParams.get('vy') === 'lista' ? 'list' : null);
  const initTable = initParams.get('tabell');
  const initSearch = initParams.get('sok') || '';

  const [search, setSearch] = useState(initSearch);
  const [expandAll, setExpandAll] = useState(false);
  const [view, setView] = useState<'list' | 'diagram'>(initView || (initTable ? 'diagram' : 'list'));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync URL when state changes
  const handleSetView = useCallback((v: 'list' | 'diagram') => {
    setView(v);
    setParam('vy', v === 'diagram' ? 'relationer' : 'lista');
    if (v === 'list') setParam('tabell', null);
  }, [setParam]);

  const handleSetSearch = useCallback((s: string) => {
    setSearch(s);
    setParam('sok', s || null);
  }, [setParam]);

  // Listen for table selection changes from RelationDiagram
  const handleTableSelect = useCallback((name: string | null) => {
    setParam('tabell', name);
  }, [setParam]);

  const [data, setData] = useState<SchemaResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetchSchema()
      .then((d) => {
        if (active) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.tables;
    const q = search.toLowerCase();
    return data.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [data, search]);

  const totalRows = useMemo(() => {
    if (!data) return 0;
    return data.tables.reduce((sum, t) => sum + t.rowCount, 0);
  }, [data]);

  const subtitle = data ? `${data.totalTables} tabeller · ${totalRows.toLocaleString('sv-SE')} rader` : undefined;

  return (
    <>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>DB Schema</h1>
        {subtitle && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Controls bar — single compact row */}
        <div style={{ padding: '4px 16px', flexShrink: 0, borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* View toggle */}
          <div style={{ display: 'flex', borderRadius: 6, border: '1px solid #d1d5db', overflow: 'hidden' }}>
            <button
              onClick={() => handleSetView('list')}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: view === 'list' ? '#2563eb' : '#fff',
                color: view === 'list' ? '#fff' : '#374151',
                border: 'none', borderRight: '1px solid #d1d5db',
              }}
            >
              <List size={12} /> Tabeller
            </button>
            <button
              onClick={() => handleSetView('diagram')}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: view === 'diagram' ? '#2563eb' : '#fff',
                color: view === 'diagram' ? '#fff' : '#374151',
                border: 'none',
              }}
            >
              <GitBranch size={12} /> Relationer
            </button>
          </div>

          {view === 'list' && (
            <>
              <div style={{ position: 'relative', flex: 1, maxWidth: 300 }}>
                <Search size={13} color="#9ca3af" style={{ position: 'absolute', left: 8, top: 6 }} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => handleSetSearch(e.target.value)}
                  placeholder="Sök tabell..."
                  style={{
                    width: '100%', padding: '4px 8px 4px 26px', borderRadius: 6,
                    border: '1px solid #d1d5db', fontSize: 12, outline: 'none',
                  }}
                />
              </div>
              <button
                onClick={() => setExpandAll(!expandAll)}
                style={{
                  padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db',
                  background: expandAll ? '#eff6ff' : '#fff', color: expandAll ? '#2563eb' : '#374151',
                  fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {expandAll ? 'Minimera' : 'Expandera'}
              </button>
            </>
          )}
        </div>

        {/* Content area — scrollable */}
        {isLoading && (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 14 }}>
            Laddar databasstruktur...
          </div>
        )}
        {error && (
          <div style={{ textAlign: 'center', color: '#dc2626', padding: 40, fontSize: 14 }}>
            Kunde inte ladda DB-schema. Kontrollera att du är inloggad.
          </div>
        )}

        {data && view === 'list' && (
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '0 24px 24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 1100, margin: '0 auto' }}>
              {filtered.length === 0 && (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>
                  Inga tabeller matchar &quot;{search}&quot;
                </div>
              )}
              {filtered.map((t) => (
                <TableCard
                  key={`${t.name}-${expandAll}`}
                  table={t}
                  allTables={data.tables}
                  defaultExpanded={expandAll}
                  onNavigate={(name) => {
                    handleSetSearch(name);
                    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {data && view === 'diagram' && (
          <RelationDiagram tables={data.tables} initialTable={initTable} onTableChange={handleTableSelect} />
        )}
      </div>
    </>
  );
}
