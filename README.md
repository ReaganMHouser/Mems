# Keepsake Wall

A simple website where family and friends share photos and memories on one page — for remembering someone, or for a birthday or other celebration.

- **You (the organizer)** sign in, make a page, and share its link or QR code.
- **Everyone else** just opens the link. No account needed — they type their name, add up to 10 photos and a message, and post.
- Everyone sees all the posts in a square photo grid. Tap a square to scroll through the posts and swipe through each one's photos.

> The name "Keepsake Wall" is a placeholder. To change it, edit `window.APP_NAME` in **config.js**, the `<title>` and brand text in **index.html**, and the `name` in **manifest.webmanifest**.

---

## Setup (about 15 minutes, one time)

You can reuse the same Supabase project as your Photo Journal. This site only adds new things whose names start with `mw_` and a new photo folder called `memory-photos`, so your journal is not touched.

### Step 1 — Set up the database
1. Go to **supabase.com** and open your project.
2. In the left menu, click **SQL Editor**, then **New query**.
3. Open the file **setup.sql** from this folder, copy everything in it, and paste it into the editor.
4. Click **Run**. You should see "Success". (It's safe to run again later if you ever need to.)

### Step 2 — Put the files on GitHub
1. Go to **github.com** and sign in.
2. Click the **+** in the top right → **New repository**.
3. Name it something like `keepsake-wall`. Leave everything else as is. Click **Create repository**.
4. On the next page, click the link **"uploading an existing file"**.
5. Drag in **all the files from this folder** (index.html, styles.css, app.js, config.js, setup.sql, manifest.webmanifest, the three icon .png files, README.md).
6. Click **Commit changes**.

### Step 3 — Put the website online with Netlify
1. Go to **netlify.com** and sign in (you can use "Sign in with GitHub").
2. Click **Add new site** → **Import an existing project** → **GitHub**.
3. Pick your `keepsake-wall` repository.
4. Leave **every build setting blank** (no build command, no publish directory). Click **Deploy**.
5. After a minute you'll get a web address like `https://something.netlify.app`. That's your site. (You can rename it under **Site configuration → Change site name**.)

### Step 4 — Tell Supabase about the new address (only if needed)
Signing in with email and password usually works right away. If you ever get a sign-in or "redirect" error:
1. In Supabase, go to **Authentication → URL Configuration**.
2. Under **Redirect URLs**, click **Add URL** and paste your Netlify address. Save.

### Step 5 — Make your first page
1. Open your Netlify address. Sign in with your Photo Journal email and password.
2. Tap **+ New page**. Choose "In memory of someone" or "A celebration", type the name, add dates or a short line, and choose a cover photo if you like.
3. Tap **Create page**. The share window opens with the link and a QR code.
   - **Copy** the link to send by text or email.
   - **Download QR (PNG)** to print it on a program, card, or sign.
4. Any time later, open the page from **My pages** to share again, **Edit page**, turn **Posting** on or off, or remove a post (tap a post, then the **⋯** button).

---

## Good to know
- **One post per person** is kept "on the honor system": each phone or computer remembers its own post, so the button changes to **Edit my memory** and the person can edit or delete it from that same device. Someone could post again from a different device or a private browser window, and if they clear their browser they can't edit their old post anymore. You can always remove any post.
- **Limits:** 10 photos per post, 3,000 characters per message, 60 characters per name, 500 posts per page.
- **Privacy:** only people with the link can see a page. The link has a long random code that can't be guessed. Photos are private and shown through links that expire after an hour. Anyone you send the link to can forward it, though.
- **Closing a page** stops new posts, but people can still view it.
- Photos are shrunk on the person's phone before uploading, so posting is quick even on slow connections.
# Mems
