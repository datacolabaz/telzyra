# Meta App Review — submission pack (Facebook Pages + Instagram publishing)

App: **Telzyra Integrations** · App ID `987843887723035` · Facebook Login for Business · Graph API v27.0
Prepared 2026-11-15. Texts in English because Meta's review forms are in English.

Goal: let any Telzyra user connect their own Facebook Pages and Instagram professional accounts and
publish/schedule posts from workflows. Until review passes, only people with a role on the app
(admins, developers, testers) can connect.

## 1. Status

| Item | Status | Owner |
|---|---|---|
| App created, use cases "Manage everything on your Page" + "Manage messaging & content on Instagram" | ✅ | done |
| Permissions added to the use cases (Ready for testing) | ✅ pages_show_list, pages_read_engagement, pages_manage_posts, business_management, instagram_basic, instagram_content_publish | done |
| Real API calls made with every permission (Meta requires at least one call before review) | ✅ 2026-11-15 (list pages/accounts, Page post create+delete, Instagram image publish, publishing limit) | done |
| Basic settings: privacy URL, terms URL, app domain, category, data deletion callback URL | ✅ saved | done |
| Facebook Login for Business redirect URI `https://api.telzyra.com/v1/oauth/meta/callback` | ✅ saved (localhost is allowed automatically in development mode) | done |
| Data deletion callback `POST https://api.telzyra.com/webhooks/meta/data-deletion` + status page `/data-deletion` | ✅ code + tests on `feature/integrations` | **needs production deploy** |
| Privacy Policy section "Connected apps" (Meta + Google Limited Use) | ✅ drafted (en/az/ru/tr) | **owner to review wording, then deploy** |
| App icon 1024×1024 | ⏳ upload in Settings → Basic → App icon | owner |
| Business Verification (company documents) | ⏳ | owner |
| "Become a Tech Provider" (Dashboard) | ⏳ requires Business Verification | owner |
| Production: integrations deployed, `META_APP_ID`, `META_APP_SECRET`, `PUBLIC_WEBHOOK_URL` set on Railway, accounts open | ⏳ | **owner approval required** |
| Reviewer test account on telzyra.com + screencast | ⏳ after production deploy | Claude prepares, owner records/approves |
| Submit for review | ⏳ | owner clicks Submit |

**Blocking order:** Business Verification → production deploy (with owner approval) → screencast →
Tech Provider + App Review submission.

## 2. Permissions and justifications (paste into "Tell us how you're using this permission")

All requests are for **Advanced Access**.

### pages_show_list
Telzyra is a workflow automation platform. When a user connects Facebook, we call `GET /me/accounts`
to show the list of Pages they manage, so they can choose which Page a workflow publishes to. We show
the Page name and category only; nothing is shown to other users.

### pages_read_engagement
Required by `pages_manage_posts`. We read basic metadata of the Pages the user manages (name,
category, the user's tasks on the Page) and the Page access token through `GET /me/accounts`, to show
the Page in the builder and to publish to it. The id and link of each post our app creates are shown
in the user's workflow run history. We do not read posts by others, follower data or insights.

### pages_manage_posts
Users build workflows such as "When a new product is added to my store, publish a post with its photo
on my Facebook Page" or "Every Monday at 10:00, publish the post from my content calendar". Telzyra
publishes the text, link or photo the user configured to the Page the user selected
(`POST /{page-id}/feed`, `POST /{page-id}/photos`, scheduled with `published=false` +
`scheduled_publish_time`). Users can also delete a post the workflow created (`DELETE /{post-id}`).
Posts are only made by workflows the Page admin created and activated.

### business_management
Pages owned by a business portfolio are only returned to apps with this permission. We use it only to
list the Pages and connected Instagram accounts the user manages through their business portfolio, so
those Pages can be selected as a publishing target. We do not manage business assets, ad accounts or
people.

### instagram_basic
After the user connects, we read the Instagram professional account linked to each selected Page
(`GET /me/accounts?fields=instagram_business_account{id,username,name}`) to show the username and use
the account id as the publishing target, and we read the permalink of each post our app publishes so
the user can open it from the run history. We do not read the user's media library or followers.

### instagram_content_publish
Users build workflows that publish to their Instagram professional account: single images, carousels
(2–20 items) and Reels, with the caption they configured (`POST /{ig-user-id}/media`, status polling,
`POST /{ig-user-id}/media_publish`). Before publishing we check `content_publishing_limit` so the
user's quota is respected and the workflow shows a clear message when the daily limit is reached.

## 3. Screencast script (one video, ~3–4 minutes, English UI)

Record at 1080p with the browser address bar visible. No personal data of other people on screen.

1. Open `https://telzyra.com`, sign in with the reviewer test account.
2. Integrations → **Facebook Pages → Connect**. Show the Facebook Login for Business dialog: choose
   the business, the Page and the Instagram account, and the permission screen listing
   `pages_show_list, pages_read_engagement, pages_manage_posts, business_management,
   instagram_basic, instagram_content_publish`. Click Save.
3. Back in Telzyra: the connection shows **Active**. Open the workflow builder, add the step
   **Facebook Pages → List Pages**, click **Test step** → the Page appears (*pages_show_list,
   business_management, pages_read_engagement*).
4. New workflow: trigger **Manual**, step **Facebook Pages → Publish photo** with a photo URL and a
   caption → **Activate → Run** → open the Page on facebook.com and show the new post
   (*pages_manage_posts*). Then run **Delete post** and show it disappears.
5. Step **Instagram → List accounts** → the account appears (*instagram_basic*).
6. Step **Instagram → Publish image** with an image URL and caption → Run → open the account on
   instagram.com and show the post (*instagram_content_publish*). Show **Get publishing limit**.
7. Show **Integrations → Disconnect**, and the page `https://telzyra.com/data-deletion`.

## 4. Reviewer instructions (paste into "App verification details")

1. Go to https://telzyra.com/login and sign in with: email `<reviewer account email>` / password
   `<set before submission, never committed>`.
2. Open Integrations → Facebook Pages → Connect and log in with your Facebook test user.
3. Open Workflows → "Meta review demo" and click Run; the workflow publishes a photo to the selected
   Page and an image to the linked Instagram account. Run history shows the post links.
4. Data deletion: Facebook Settings → Business integrations → remove Telzyra; the callback deletes our
   stored tokens and returns a confirmation code you can check at https://telzyra.com/data-deletion.

## 5. Notes

- Meta fetches media from the URL the user provides; hosts that block Meta's crawler (e.g. Wikimedia)
  fail with a clear `VALIDATION` error and nothing is published (verified 2026-11-15).
- Instagram posts published through the API cannot be deleted through the API; the user deletes them
  in the Instagram app. Facebook Page posts can be deleted by the workflow.
- The long-lived user token lasts ~60 days and is not refreshable; the connection then shows
  "Reconnect". Page tokens are derived per call and never stored.
