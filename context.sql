
WITH 
table_stats AS (
  SELECT 
    t.table_schema,
    t.table_name,
    COALESCE(c.reltuples::bigint, 0) AS row_count
  FROM information_schema.tables t
  LEFT JOIN pg_class c 
    ON c.relname = t.table_name
  LEFT JOIN pg_namespace n 
    ON n.oid = c.relnamespace AND n.nspname = t.table_schema
  WHERE t.table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
    AND t.table_type = 'BASE TABLE'
),
table_columns AS (
  SELECT 
    c.table_schema,
    c.table_name,
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default,
    c.ordinal_position
  FROM information_schema.columns c
  WHERE c.table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
),
foreign_keys AS (
  SELECT 
    tc.table_schema,
    tc.table_name,
    kcu.column_name,
    ccu.table_schema AS foreign_table_schema,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    tc.constraint_name,
    -- поведение при удалении/обновлении
    rc.update_rule,
    rc.delete_rule
  FROM information_schema.table_constraints AS tc
  JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
    AND ccu.table_schema = tc.table_schema
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name
    AND rc.constraint_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
),
primary_keys AS (
  SELECT 
    tc.table_schema,
    tc.table_name,
    kcu.column_name,
    kcu.ordinal_position,
    tc.constraint_name
  FROM information_schema.table_constraints AS tc
  JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
),
per_table AS (
  SELECT 
    ts.table_schema,
    ts.table_name,
    ts.row_count,
    json_agg(
      json_build_object(
        'column_name', tc.column_name,
        'data_type', tc.data_type,
        'is_nullable', tc.is_nullable,
        'column_default', tc.column_default,
        'ordinal_position', tc.ordinal_position,
        'is_primary_key', CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END,
        'fk', CASE 
          WHEN fk.column_name IS NOT NULL THEN json_build_object(
            'references_schema', fk.foreign_table_schema,
            'references_table', fk.foreign_table_name,
            'references_column', fk.foreign_column_name,
            'constraint_name', fk.constraint_name,
            'on_update', fk.update_rule,
            'on_delete', fk.delete_rule
          ) ELSE NULL END
      )
      ORDER BY tc.ordinal_position
    ) AS cols_json,
    COALESCE((
      SELECT json_agg(
        json_build_object(
          'column', fk2.column_name,
          'references_schema', fk2.foreign_table_schema,
          'references_table', fk2.foreign_table_name,
          'references_column', fk2.foreign_column_name,
          'constraint_name', fk2.constraint_name,
          'on_update', fk2.update_rule,
          'on_delete', fk2.delete_rule
        )
        ORDER BY fk2.constraint_name, fk2.column_name
      )
      FROM foreign_keys fk2
      WHERE fk2.table_schema = ts.table_schema
        AND fk2.table_name = ts.table_name
    ), '[]'::json) AS outgoing_json,
    COALESCE((
      SELECT json_agg(
        json_build_object(
          'from_schema', fk3.table_schema,
          'from_table', fk3.table_name,
          'from_column', fk3.column_name,
          'to_column', fk3.foreign_column_name,
          'constraint_name', fk3.constraint_name,
          'on_update', fk3.update_rule,
          'on_delete', fk3.delete_rule
        )
        ORDER BY fk3.constraint_name, fk3.table_name, fk3.column_name
      )
      FROM foreign_keys fk3
      WHERE fk3.foreign_table_schema = ts.table_schema
        AND fk3.foreign_table_name = ts.table_name
    ), '[]'::json) AS incoming_json
  FROM table_stats ts
  LEFT JOIN table_columns tc 
    ON ts.table_schema = tc.table_schema AND ts.table_name = tc.table_name
  LEFT JOIN primary_keys pk 
    ON tc.table_schema = pk.table_schema 
    AND tc.table_name = pk.table_name 
    AND tc.column_name = pk.column_name
  LEFT JOIN foreign_keys fk 
    ON tc.table_schema = fk.table_schema 
    AND tc.table_name = fk.table_name 
    AND tc.column_name = fk.column_name
  GROUP BY ts.table_schema, ts.table_name, ts.row_count
),
-- разворачиваем JSON в строки для форматирования таблиц md
cols AS (
  SELECT 
    p.table_schema,
    p.table_name,
    (c->>'ordinal_position')::int AS ord,
    c->>'column_name' AS column_name,
    c->>'data_type' AS data_type,
    c->>'is_nullable' AS is_nullable,
    c->>'column_default' AS column_default,
    COALESCE((c->>'is_primary_key')::boolean, false) AS is_pk,
    c->'fk' AS fk
  FROM per_table p,
  LATERAL jsonb_to_recordset(p.cols_json::jsonb) AS c(
    column_name text,
    data_type text,
    is_nullable text,
    column_default text,
    ordinal_position int,
    is_primary_key boolean,
    fk jsonb
  )
),
out_fk AS (
  SELECT 
    p.table_schema,
    p.table_name,
    jsonb_array_elements(p.outgoing_json::jsonb) AS j
  FROM per_table p
),
in_fk AS (
  SELECT 
    p.table_schema,
    p.table_name,
    jsonb_array_elements(p.incoming_json::jsonb) AS j
  FROM per_table p
),
-- формируем markdown по таблицам
table_md AS (
  SELECT 
    p.table_schema,
    p.table_name,
    (
      '# ' || p.table_schema || '.' || p.table_name || E'\n\n' ||
      '**Rows**: ' || p.row_count || E'\n\n' ||
      '### Columns' || E'\n' ||
      '| name | type | null | default | PK | FK |' || E'\n' ||
      '|--|--|--|--|--|--|' || E'\n' ||
      COALESCE((
        SELECT string_agg(
          '| ' ||
          quote_ident(c.column_name) || ' | ' ||
          COALESCE(c.data_type, '') || ' | ' ||
          CASE WHEN c.is_nullable = 'YES' THEN 'YES' ELSE 'NO' END || ' | ' ||
          COALESCE(replace(replace(c.column_default, E'\n',' '), '|','\\|'), '') || ' | ' ||
          CASE WHEN c.is_pk THEN '✓' ELSE '' END || ' | ' ||
          COALESCE(
            CASE WHEN c.fk IS NULL THEN ''
                 ELSE (
                   (c.fk->>'references_schema') || '.' ||
                   (c.fk->>'references_table') || '(' ||
                   (c.fk->>'references_column') || ')' ||
                   ' [' || (c.fk->>'constraint_name') || ']' ||
                   ' ON UPDATE ' || (c.fk->>'on_update') ||
                   ' ON DELETE ' || (c.fk->>'on_delete')
                 )
            END
          , '') || ' |'
          , E'\n' ORDER BY c.ord
        )
        FROM cols c
        WHERE c.table_schema = p.table_schema AND c.table_name = p.table_name
      ), '') || E'\n\n' ||
      '### Outgoing FKs' || E'\n' ||
      '| column | references | rule |' || E'\n' ||
      '|--|--|--|' || E'\n' ||
      COALESCE((
        SELECT string_agg(
          '| ' ||
          quote_ident(j->>'column') || ' | ' ||
          (j->>'references_schema') || '.' || (j->>'references_table') || '(' || (j->>'references_column') || ')' ||
          ' [' || (j->>'constraint_name') || ']' || ' | ' ||
          'UPDATE ' || (j->>'on_update') || ', DELETE ' || (j->>'on_delete') || ' |'
          , E'\n'
        )
        FROM out_fk ofk
        WHERE ofk.table_schema = p.table_schema AND ofk.table_name = p.table_name
      ), '') || E'\n\n' ||
      '### Incoming FKs' || E'\n' ||
      '| from | column | rule |' || E'\n' ||
      '|--|--|--|' || E'\n' ||
      COALESCE((
        SELECT string_agg(
          '| ' ||
          (j->>'from_schema') || '.' || (j->>'from_table') || ' | ' ||
          quote_ident(j->>'from_column') || ' -> ' || quote_ident(j->>'to_column') || ' | ' ||
          (j->>'constraint_name') || ' (UPDATE ' || (j->>'on_update') || ', DELETE ' || (j->>'on_delete') || ')' || ' |'
          , E'\n'
        )
        FROM in_fk ifk
        WHERE ifk.table_schema = p.table_schema AND ifk.table_name = p.table_name
      ), '') || E'\n'
    ) AS md
  FROM per_table p
)
SELECT string_agg(md, E'\n---\n\n') AS md_content
FROM table_md
ORDER BY 1;
