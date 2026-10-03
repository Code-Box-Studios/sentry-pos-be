-- The sole audit immutability exception is completed owner end-of-life (§8).
-- Transaction-local context alone never grants deletion: the database itself
-- verifies BOTH the recorded deadline and at least90 elapsed days of closure.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
DECLARE purge_owner uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    purge_owner := nullif(current_setting('sentry.purge_owner', true), '')::uuid;
    IF purge_owner IS NOT NULL AND EXISTS (
      SELECT 1 FROM owners WHERE id=purge_owner AND status='closed'
        AND closed_at <= CURRENT_TIMESTAMP - INTERVAL '90 days'
        AND purge_after <= CURRENT_TIMESTAMP
    ) AND (
      OLD.owner_id=purge_owner
      OR (OLD.entity_type='owner' AND OLD.entity_id=purge_owner)
      OR OLD.business_id IN (SELECT id FROM businesses WHERE owner_id=purge_owner)
      OR OLD.metadata->>'browsedBusinessId' IN (SELECT id::text FROM businesses WHERE owner_id=purge_owner)
    ) THEN RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
