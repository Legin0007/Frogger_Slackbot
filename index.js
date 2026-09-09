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
    userScopes: ["users.profile:write"]
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
    text: `<@${requesterId}> wants to add you to the channel. Click here to accept and join: ${url}`
  });

  await respond({ text: `Sent a request to <@${targetUserId}>.` });
});

(async () => {
  await app.start();
  console.log("bot is running!");
})();