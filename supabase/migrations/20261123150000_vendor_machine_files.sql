-- Vendor logins (scope 'invoiced') can see the parameter and log files of the machines on jobs billed to them.
drop policy if exists files_vendor on public.machine_files;
create policy files_vendor on public.machine_files for select to authenticated using (
  machine_id is not null and machine_id in (select public.vendor_machine_ids()));
