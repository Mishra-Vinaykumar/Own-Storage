# Private Storage API

One private file API backed by a pool of MEGA accounts. API callers see one
virtual drive; the server chooses an account for every upload and saves that
account id with the file metadata. Downloads and deletes are automatically sent
back to the correct account.

The existing `private-file-portal` and `private-file-portal2` projects are left
untouched.

## How routing works

- `least-used` (default): uploads to the account with the fewest bytes assigned
  by this API.
- `round-robin`: rotates between the configured accounts.
- If the selected account rejects an upload, the pool tries the remaining
  accounts before returning an error.
- The public response never includes the MEGA account id or remote node id.

This creates one virtual pool. It does not literally merge the accounts inside
MEGA, and it does not split a single file across accounts.

## Use the two existing account configurations

From this directory:

```powershell
npm install
npm run import:config
npm run import:metadata
npm run setup:admin
npm test
npm start
```

`import:config` reads the two sibling `.env` files, creates this project's
private `.env`, and generates a new API key. It does not print credentials.
`import:metadata` makes existing compatible MEGA metadata visible through the
combined API. It does not upload, delete, or move anything in MEGA. Local-only
files are skipped while the new service is in MEGA mode.

Open `http://localhost:3000` for the user portal. The administrator signs in
through the same page and is redirected to `http://localhost:3000/admin.html`.

## User approval and administrator dashboard

Set the bootstrap administrator in `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-admin-password
```

The browser workflow is:

1. A visitor selects **Create account** and registers.
2. The account is saved with `pending` status and cannot sign in yet.
3. The administrator opens the admin dashboard and approves or blocks it.
4. An approved user can create private folders and upload, preview, download or
   delete files.
5. Blocking a user is checked on every protected request, so it takes effect
   immediately even when that user already has a browser session.

Passwords are stored as salted scrypt hashes in `data/users.json`; plaintext
passwords are not stored there. Browser users cannot see other users' files or
folders.

## Configuration

Copy `.env.example` to `.env` for a manual setup. Account ids in
`STORAGE_ACCOUNTS` map to environment-variable prefixes:

```env
STORAGE_DRIVER=mega
STORAGE_ACCOUNTS=vinay,ankita
STORAGE_STRATEGY=least-used

MEGA_VINAY_EMAIL=...
MEGA_VINAY_PASSWORD=...
MEGA_VINAY_FOLDER=CRM-Portal-Uploads

MEGA_ANKITA_EMAIL=...
MEGA_ANKITA_PASSWORD=...
MEGA_ANKITA_FOLDER=CRM-Portal-Uploads
```

Use `STORAGE_DRIVER=local` with the same account list to test the pool without
contacting MEGA. Local files go into `storage/<account-id>/`.

## Private API authentication

Configure one or more owners and keys:

```env
API_KEYS=customer-one:a-long-random-key;customer-two:another-random-key
```

Each key is a separate private file namespace. A customer cannot list, download,
or delete another customer's files.

Example upload in PowerShell:

```powershell
curl.exe -X POST http://localhost:3000/api/files `
  -H "Authorization: Bearer YOUR_KEY" `
  -F "file=@C:\path\document.pdf"
```

Endpoints:

- `GET /api/health` - service status and configured account count
- `GET /api/files` - list the authenticated owner's files
- `POST /api/files` - upload multipart field `file`
- `GET /api/files/:id/content` - download
- `GET /api/files/:id/content?preview=1` - inline preview when supported
- `DELETE /api/files/:id` - permanently delete
- `GET /api/storage` - combined available storage reported by reachable accounts
- `GET /api/folders` - list folders under `parentId`
- `POST /api/folders` - create a private folder
- `DELETE /api/folders/:id` - delete an empty private folder

Account administration endpoints (administrator session only):

- `POST /api/register` - create a pending browser account
- `GET /api/admin/users` - list registered users and statuses
- `GET /api/admin/stats` - dashboard totals
- `PATCH /api/admin/users/:username` - set `pending`, `approved`, or `blocked`

Browser sessions use `POST /api/login`, `GET /api/me`, and `POST /api/logout`.

## Production notes

This is a working prototype, not yet a public SaaS. MEGAJS is unofficial. Before
giving the service to untrusted customers, replace JSON metadata and the memory
session store with a database-backed design, hash customer API keys, add HTTPS,
CSRF protection, per-customer quotas, audit logging, malware scanning, streaming
uploads/downloads, backups, and stronger rate limits. Never expose `.env` or the
MEGA account credentials.
