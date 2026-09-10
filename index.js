require("dotenv").config();

const { App } = require("@slack/bolt");
const { WebClient } = require("@slack/web-api");
const Database = require("better-sqlite3");

const TARGET_CHANNEL_ID = "C0BDJ5T357X";

const db = new Database("./tokens.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS user_tokens (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL
  )
`);

const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const app = new App({
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  redirectUri: "https://frogger.legin.hackclub.app/slack/oauth_redirect",
  scopes: [],
  installerOptions: {
    userScopes: ["users.profile:write"],
    redirectUriPath: "/slack/oauth_redirect",
    legacyStateVerification: true,
    stateExpirationSeconds: 172800 // 42 hours
  },
  installationStore: {
    storeInstallation: async (installation) => {
      const userId = installation.user.id;
      const token = installation.user.token;

      db.prepare(`
        INSERT INTO user_tokens (user_id, token)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET token = excluded.token
      `).run(userId, token);

      // Set their status using their new user token
      try {
        const userClient = new WebClient(token);
        await userClient.users.profile.set({
          profile: {
            status_text: "frog",
            status_emoji: ":froga:",
            status_expiration: 0
          }
        });
      } catch (err) {
        console.error(`Failed to set status for ${userId}:`, err.message);
      }

      // They just were approved now adding them to the channel
      try {
        await botClient.conversations.invite({
          channel: TARGET_CHANNEL_ID,
          users: userId
        });
      } catch (err) {
        if (err.data?.error !== "already_in_channel") {
          console.error(`Failed to invite ${userId}:`, err.message);
        }
      }

      // Confirm in their DM
      try {
        const dm = await botClient.conversations.open({ users: userId });
        await botClient.chat.postMessage({
          channel: dm.channel.id,
          text: "Thanks! You've been added to the channel. :froga:"
        });
      } catch (err) {
        console.error(`Failed to confirm with ${userId}:`, err.message);
      }
    },
    fetchInstallation: async (installQuery) => {
      const row = db.prepare(`SELECT token FROM user_tokens WHERE user_id = ?`).get(installQuery.userId);

      return {
        team: { id: installQuery.teamId },
        enterprise: installQuery.enterpriseId ? { id: installQuery.enterpriseId } : undefined,
        user: {
          id: installQuery.userId,
          token: row ? row.token : undefined
        },
        bot: {
          token: process.env.SLACK_BOT_TOKEN,
          id: undefined,
          userId: undefined
        }
      };
    }
  }
});

app.command("/frogify", async ({ command, ack, respond, client }) => {
  await ack();

  const match = command.text.match(/<@(\w+)\|?.*>/);
  if (!match) {
    await respond({ text: "Please mention a user, like `/frogify @someone`" });
    return;
  }
  const targetUserId = match[1];
  const requesterId = command.user_id;

  const url = await app.receiver.installer.generateInstallUrl({
    scopes: [],
    userScopes: ["users.profile:write"],
    metadata: JSON.stringify({ requesterId })
  });

  const dm = await client.conversations.open({ users: targetUserId });

  await client.chat.postMessage({
  channel: dm.channel.id,
  text: `Welcome to the new epidemic. If you fail to participate, the frogs will be sad.
You have been infected. Now change your status to "DM me the word frog for a surprise." The infection shall spread silently.
The only rule is to not spoil the game for others by telling people what saying frog does. You have to keep the status for at least 1 month :froga:.
<@${requesterId}> wants to add you to the channel. Click here to accept and join: ${url}
If anyone DMs you the word frog, run /frogify @person and it will add them to the channel.`
});;

  await respond({ text: `Sent a request to <@${targetUserId}>.` });
});

app.command("/frogify-all", async ({ command, ack, respond, client }) => {
  await ack();

  const requesterId = command.user_id;

  const url = await app.receiver.installer.generateInstallUrl({
    scopes: [],
    userScopes: ["users.profile:write"],
    metadata: JSON.stringify({ requesterId })
  });

  // Get every member currently in the target channel
  let members = [];
  try {
    const result = await botClient.conversations.members({
      channel: TARGET_CHANNEL_ID,
      limit: 200
    });
    members = result.members || [];
  } catch (err) {
    await respond({ text: `Failed to list channel members: ${err.message}` });
    return;
  }

  await respond({ text: `Sending permission requests to ${members.length} members. This may take a minute...` });

  let sent = 0;
  let skipped = 0;

  for (const userId of members) {
    // Skip if they've already opted in
    const existing = db.prepare(`SELECT user_id FROM user_tokens WHERE user_id = ?`).get(userId);
    if (existing) {
      skipped++;
      continue;
    }

    try {
      // Skip bots (including this bot itself)
      const info = await botClient.users.info({ user: userId });
      if (info.user?.is_bot) {
        skipped++;
        continue;
      }

      const dm = await botClient.conversations.open({ users: userId });
      await botClient.chat.postMessage({
        channel: dm.channel.id,
        text: `Hey! Give Frogger permission to manage your status: ${url}`
      });
      sent++;
    } catch (err) {
      console.error(`Failed to DM ${userId}:`, err.message);
    }

    // Stay comfortably under Slack's rate limits
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  await respond({ text: `Done! Sent to ${sent} members, skipped ${skipped} (already opted in or bots).` });
});

(async () => {
  await app.start();
  console.log("bot is running!");
})();