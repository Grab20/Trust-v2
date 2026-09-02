-- Phase 3: Private Document Storage Schema Changes
-- Run this in the Supabase SQL Editor BEFORE deploying the updated index.html
-- Two-column strategy: preserve existing _url columns as fallback, add new _path columns

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add _path columns to profiles (owner ID document)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS doc_id_path TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add _path columns to driver_profiles (all private identity docs)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS doc_id_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS doc_license_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS doc_license_back_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS proof_of_residence_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS criminal_check_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS pdp_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS photo_holding_id_path TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS photo_fullbody_path TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Create private buckets (run in Supabase Dashboard → Storage → New bucket)
--    OR via the Management API. These cannot be created via SQL directly.
--
--    Bucket: owner-id-docs    → Private: YES   (owner SA ID documents)
--    Bucket: driver-id-docs   → Private: YES   (all driver identity/verification docs)
--
--    The existing public buckets remain unchanged:
--    profile-photos  → keep PUBLIC  (headshots shown in marketplace, selfies)
--    driver-docs     → keep PUBLIC  (screenshots; will phase out identity docs)
--    car-photos      → keep PUBLIC  (vehicle photos)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Storage RLS policies for owner-id-docs (private bucket)
--    These policies allow the service role (used by Netlify functions) full access.
--    Authenticated users can upload their own files only.
--    Reads (downloads) are blocked for all authenticated/anon users —
--    all reads must go through the get-signed-url function.
-- ─────────────────────────────────────────────────────────────────────────────

-- Allow owners to upload their own ID doc (path must start with their UID)
DROP POLICY IF EXISTS "owner_upload_own_id" ON storage.objects;
CREATE POLICY "owner_upload_own_id"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'owner-id-docs'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow owners to update (replace) their own ID doc
DROP POLICY IF EXISTS "owner_update_own_id" ON storage.objects;
CREATE POLICY "owner_update_own_id"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'owner-id-docs'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Block all direct reads — signed URLs bypass RLS via service role
-- (No SELECT policy = no direct read access for authenticated/anon users)

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Storage RLS policies for driver-id-docs (private bucket)
-- ─────────────────────────────────────────────────────────────────────────────

-- Allow drivers to upload their own documents
DROP POLICY IF EXISTS "driver_upload_own_docs" ON storage.objects;
CREATE POLICY "driver_upload_own_docs"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'driver-id-docs'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow drivers to update (replace) their own documents
DROP POLICY IF EXISTS "driver_update_own_docs" ON storage.objects;
CREATE POLICY "driver_update_own_docs"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'driver-id-docs'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Block all direct reads — signed URLs only via get-signed-url function

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Verification: confirm columns were added
-- ─────────────────────────────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'doc_id_path';

SELECT column_name FROM information_schema.columns
WHERE table_name = 'driver_profiles' AND column_name LIKE '%_path'
ORDER BY column_name;
