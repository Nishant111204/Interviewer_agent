-- Add face descriptor column to sessions table
-- Stores 128-dimensional face embedding vector as real array
alter table sessions
  add column if not exists face_descriptor real[];

-- real[] = native Postgres float4 array (128 x 4-byte floats = 512 bytes).
-- No NOT NULL — sessions created before this feature have no descriptor.
-- One-write semantics enforced at the API layer (check IS NOT NULL before updating).
