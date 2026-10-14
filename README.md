# PopHealth site

A static website for GitHub Pages with a username login, a configurable main page, and an admin dashboard with a drag-and-drop page designer. It uses plain HTML, CSS and JS, with no build step.

| Page | File | Purpose |
|---|---|---|
| Login | `index.html` | Enter a username listed in `data/users.json` |
| Main | `main.html` | Renders `data/layout.json`; shows **Admin Dashboard** button for Admin users |
| Admin | `admin.html` | Page designer, user management, publish |
| Emergency Change | `ecr.html` | Fill in the ECR form, then **Create template** copies an Outlook-ready approval email |
| Pre-Approved Change | `pac.html` | Same as above for pre-approved CRs (SCR) |

Both templates share `js/template-form.js`; each page only has a small config (`js/ecr.js`, `js/pac.js`) listing its fields, email intro and checks.

## Deploy to GitHub Pages

1. Create a repo on GitHub and push this folder:
   ```bash
   git init && git add . && git commit -m "Initial site"
   git branch -M main
   git remote add origin https://github.com/kailknight/OnePopHealth.git
   git push -u origin main
   ```
2. In the repo, go to **Settings → Pages → Build and deployment**, set Source to **Deploy from a branch**, then pick `main` and `/ (root)`.
3. Open `https://kailknight.github.io/OnePopHealth/` and log in as `admin`.

## Using the admin dashboard

- **Page designer:** drag blocks (hero, heading, paragraph, image, button, card, list, video, divider, spacer) onto the page. Drag them to reorder, and click one to edit its properties. Click empty space to edit page-wide settings (title, colours, font, width). Set a block's **Width** to 1/2, 1/3 and so on to put blocks side by side.
- **Users:** add or remove users and set their role (`User` or `Admin`).
- **Publish:** edits are saved as a *draft in your browser* until you publish. Publishing commits `data/layout.json` and `data/users.json` to the repo through the GitHub API, using a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to this repo with **Contents: Read and write**. If you'd rather not use a token, download the JSON files and commit them yourself.

## Run locally

`fetch()` doesn't work over `file://`, so serve the folder. For example: `npx serve .` or `python -m http.server`.

## ⚠️ Security note

GitHub Pages only serves static files, so this login is **not secure**. Anyone can type `admin`, and `data/users.json` is public. That's fine for demos, internal prototypes and personalising content. It is **not** suitable for protecting private or health data. For real authentication, put the site behind a real identity provider, such as Azure Static Web Apps auth, Cloudflare Access, Auth0 or Firebase Auth.

The publish token never goes into the repo. It's kept in your browser only if you tick "Remember token".

## Editing the code

GitHub Pages lets browsers cache files for 10 minutes. When you change any file in `js/` or `css/`, bump the `?v=N` number on its `<script>` / `<link>` tags in `index.html`, `main.html` and `admin.html` so visitors don't get a mix of old and new files.

## Roles

| Role | Can do |
|---|---|
| **Admin** | Everything, including the Admin Dashboard |
| **Approver** | Open the VA Tracker from the VA tiles; approve or reject change requests (`approvals.html`) |
| **User** | Open the VA Tracker; submit Emergency / Pre-Approved Change requests |
| **View** | Read-only: sees the page and VA numbers, but can't open the VA Tracker or submit |



## Domains

**VA per domain:** Admin → VA has a **Domain** switch; each domain's VA data is saved separately (`data/va.json` for Population Health, `data/va-<domain>.json` for others). The VA summary tiles and the VA Tracker show the viewer's own domain.

Each user has a **domain** (Admin Dashboard → Users), and admins can add domains there. Dashboard blocks have **Visible to domains** in the Page designer; with none ticked, a block shows for every domain. All the current blocks are for **Population Health** only. Which domains can use the **templates** (Emergency Change, Pre-Approved Change and Approvals) is set in **Users → Domains → Who can use the templates**; the default is Population Health. Use **Preview as domain** in the designer to see what a domain sees. Type `{dashboard}` in any block text or the site title to show each domain's **Dashboard name** (Users → Domains), e.g. "Welcome to {dashboard} Dashboard" → "Welcome to OnePopHealth Dashboard" / "Welcome to OneOperations Dashboard". `{domain}` shows the domain itself.

## Change request approvals

The Emergency and Pre-Approved Change pages **submit** the email for approval. An Approver reviews it on **Approvals**, and once it's approved the submitter can **Copy email** / **Copy subject** under **My requests**. Approvers can't approve their own requests.

Approvers only see requests from users in **their own domain** (e.g. an Operation Approver sees only Operation users' requests). Admins see all domains and can filter by domain.

Requests are stored in a Supabase table `change_requests`. One-time setup is in **Admin Dashboard → Users → Approvals storage**: run the SQL shown there, enter the project URL and **anon** key, then Publish.

> Login is username-only, so roles are honour-system: anyone who types an Approver's username, or calls the API with the anon key, can approve. Don't rely on this for formal change control without real authentication.
