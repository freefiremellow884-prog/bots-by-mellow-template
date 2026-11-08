// ============ STAR BOT TEMPLATE (clone-ready, by Bots by Mellow) ============
// The creator bot adds these two lines on top of this file automatically:
//   var ADMIN_ID = <owner telegram id>;
//   var ADMIN_USERNAME = "<owner username>";
// So they are NOT declared here. No secrets are stored in this file (the GitHub repo is public).
//
// Everything else is set by the bot owner inside Telegram (admin commands):
//   /addchannel   -> join channels users must join
//   /payout       -> channel/group where withdraw requests are posted
//   /withdrawpic  -> picture used in the withdraw request post
// ---------------------------------------------------------------------------

var REWARD = 0.5; // default only. Admin changes it with /ref
var DEFAULT_MIN_WITHDRAW = 1.0;
var DEFAULT_MAX_WITHDRAW = 100;

// join channels are added by the bot owner with /addchannel (empty by default)
var DEFAULT_CHANNELS = [];

// verified users are re-checked against the channels at most once per this many ms (10 min)
var CHECK_TTL = 600000;

// message shown when withdrawals are closed (/withdraw off)
var WD_CLOSED_MSG = "Withdrawal has been closed.";

var m = String(message || "");

// a photo message has no text. Only the owner sending the withdraw picture is allowed through
var hasPhoto = (typeof request !== "undefined" && request && request.photo && request.photo.length > 0);

// ignore groups, channels and empty events
// (except the Approve / Reject buttons pressed inside the payout group)
var isGroupBtn = (m.indexOf("/wd_ok") === 0 || m.indexOf("/wd_no") === 0);
var cid = chat ? Number(chat.chatid) : 0;
if (cid < 0 && !isGroupBtn) { return; }
if (chat && chat.chat_type && chat.chat_type !== "private" && !isGroupBtn) { return; }
var hasResult = (typeof options !== "undefined" && options && options.result);
var hasContent = (typeof content !== "undefined");
// true only when the command comes from a real Api call (on_result / on_error), never from a typed message
var hasOpts = (typeof options !== "undefined" && options && options.bb_options);
if (!m && !hasResult && !hasContent && !hasPhoto) { return; }

var isAdmin = String(user.telegramid) === String(ADMIN_ID);

// photos from normal users are ignored
if (hasPhoto && !(isAdmin && User.getProperty("admin_state") === "wdpic")) { return; }

// ---------- small helpers ----------
function num(x) { var n = Number(x); return isNaN(n) ? 0 : n; }
function round2(x) { return Math.round(x * 100) / 100; }
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getObj(key) {
  var v = Bot.getProperty(key);
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return (v && typeof v === "object") ? v : null;
}

function bump(key, by, type) {
  Bot.setProperty(key, round2(num(Bot.getProperty(key)) + by), type || "integer");
}

// withdraw limits (admin changes them with /min and /max)
var MIN_WITHDRAW = num(Bot.getProperty("min_wd")) > 0 ? num(Bot.getProperty("min_wd")) : DEFAULT_MIN_WITHDRAW;
var MAX_WITHDRAW = num(Bot.getProperty("max_wd")) > 0 ? num(Bot.getProperty("max_wd")) : DEFAULT_MAX_WITHDRAW;

// withdraw fee in Stars (admin changes it with /fee + 1 , /fee - 1). Default = 0
var FEE = Math.max(0, round2(num(Bot.getProperty("wd_fee"))));

// referral reward per referral (admin changes it with /ref 1)
var _rr = num(Bot.getProperty("ref_reward"));
if (_rr > 0) { REWARD = _rr; }

// withdraw switch (admin: /withdraw on , /withdraw off). Default = ON
var WD_ON = String(Bot.getProperty("wd_off")) !== "1";

// payout channel/group and withdraw picture (set by the owner with /payout and /withdrawpic)
var PAYOUT_CHAT = String(Bot.getProperty("payout_chat") || "");
var PAYOUT_LINK = PAYOUT_CHAT ? "https://t.me/" + PAYOUT_CHAT.replace("@", "") : "";
var WD_PIC = String(Bot.getProperty("wd_pic") || "");

// fee / payout of a saved request (old requests have no fee -> fee 0)
function feeOf(req) { return req && req.f !== undefined ? num(req.f) : 0; }
function netOf(req) { return req && req.net !== undefined ? num(req.net) : num(req.amt); }

// ---------- join channels (list is stored, admin can change it) ----------
function loadChannels() {
  var l = getObj("ch_list");
  if (l && Array.isArray(l)) { return l.slice(); }
  return DEFAULT_CHANNELS.slice();
}

function hasChannel(list, name) {
  var low = String(name).toLowerCase();
  for (var q = 0; q < list.length; q++) {
    if (String(list[q]).toLowerCase() === low) { return true; }
  }
  return false;
}

// accepts https://t.me/name , t.me/name , @name  ->  "@name"
function parseChannel(t) {
  t = String(t || "").trim();
  var mm = t.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/@?([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:\?\S*)?$/i);
  if (!mm) { mm = t.match(/^@([A-Za-z][A-Za-z0-9_]{3,31})$/); }
  return mm ? "@" + mm[1] : "";
}

function channelListText() {
  var l = loadChannels();
  if (l.length === 0) { return "(no channels)"; }
  var out = "";
  for (var q = 0; q < l.length; q++) { out += (q + 1) + ". " + l[q] + "\n"; }
  return out.trim();
}

// add: first check the bot can see the channel members (bot must be admin there)
function startAddChannel(name) {
  if (hasChannel(loadChannels(), name)) {
    Bot.sendMessage("" + name + " is already in the list.");
    return;
  }
  Api.getChatMember({
    chat_id: name,
    user_id: ADMIN_ID,
    on_result: "/chtest",
    on_error: "/chterror",
    bb_options: { ch: name }
  });
}

function removeChannel(name) {
  var l = loadChannels();
  var out = [];
  var found = false;
  for (var q = 0; q < l.length; q++) {
    if (String(l[q]).toLowerCase() === String(name).toLowerCase()) { found = true; } else { out.push(l[q]); }
  }
  if (!found) {
    Bot.sendMessage("" + name + " is not in the list.\n\nCurrent channels:\n" + channelListText());
    return;
  }
  Bot.setProperty("ch_list", out, "json");
  Bot.sendMessage("Channel removed: " + name + "\n\nThe join buttons are updated.\nTotal channels: " + out.length);
}

// payout channel/group: first check the bot can see it (bot must be admin there)
function startPayoutTest(name) {
  Api.getChatMember({
    chat_id: name,
    user_id: ADMIN_ID,
    on_result: "/potest",
    on_error: "/poerror",
    bb_options: { ch: name }
  });
}

var CHANNELS = loadChannels();

// ---------- remember username + name (for admin tools / leaderboard) ----------
var curU = user.username ? String(user.username).toLowerCase() : "";
if (curU && User.getProperty("saved_uname") !== curU) {
  Bot.setProperty("uname_" + curU, String(user.telegramid), "string");
  User.setProperty("saved_uname", curU, "string");
}
var curName = String(user.first_name || "User").replace(/[\r\n]/g, " ").slice(0, 25);
if (User.getProperty("saved_name") !== curName) {
  Bot.setProperty("nm_" + user.telegramid, curName, "string");
  User.setProperty("saved_name", curName, "string");
}

// ---------- broadcast delivery (runs once for every user) ----------
if (m.indexOf("/__bc") === 0) {
  var bcText = Bot.getProperty("bc_text");
  if (bcText) { Bot.sendMessage(String(bcText)); }
  return;
}

// ---------- add channel: bot can see the channel -> save it ----------
// (only real API callbacks are accepted, typed fake commands are ignored)
if (m.indexOf("/chtest") === 0) {
  if (hasResult && hasOpts && options.bb_options.ch) {
    var chNew = String(options.bb_options.ch);
    var chL = loadChannels();
    if (!hasChannel(chL, chNew)) {
      chL.push(chNew);
      Bot.setProperty("ch_list", chL, "json");
    }
    Bot.sendMessageToChatWithId(ADMIN_ID, "Channel added: " + chNew + "\n\nIt will show in the join buttons now.\nVerified users will be asked to join it the next time they use the bot.\nTotal channels: " + chL.length);
  }
  return;
}

if (m.indexOf("/chterror") === 0) {
  if (!hasOpts) { return; } // typed by a user -> ignore
  var chBad = options.bb_options.ch ? options.bb_options.ch : "that channel";
  Bot.sendMessageToChatWithId(
    ADMIN_ID,
    "Could not add " + chBad + "\n\nCheck that:\n- the link is correct (public channel/group)\n- the bot is an ADMIN of that channel/group"
  );
  return;
}

// ---------- payout chat: bot can see it -> save it ----------
if (m.indexOf("/potest") === 0) {
  if (hasResult && hasOpts && options.bb_options.ch) {
    var poNew = String(options.bb_options.ch);
    Bot.setProperty("payout_chat", poNew, "string");
    Bot.sendMessageToChatWithId(
      ADMIN_ID,
      "Payout channel set: " + poNew + "\n\nWithdraw requests will be posted there with Approve / Reject buttons.\nMake sure the bot can post messages in it."
    );
  }
  return;
}

if (m.indexOf("/poerror") === 0) {
  if (!hasOpts) { return; } // typed by a user -> ignore
  var poBad = options.bb_options.ch ? options.bb_options.ch : "that channel";
  Bot.sendMessageToChatWithId(
    ADMIN_ID,
    "Could not set " + poBad + " as the payout channel\n\nCheck that:\n- the link is correct (public channel/group)\n- the bot is an ADMIN of that channel/group"
  );
  return;
}

// ---------- withdraw picture link was tested with a preview ----------
if (m.indexOf("/picok") === 0) {
  if (hasResult && hasOpts && options.bb_options.pic) {
    Bot.setProperty("wd_pic", String(options.bb_options.pic), "string");
    Bot.sendMessageToChatWithId(ADMIN_ID, "Withdraw picture saved.\n\nThis picture will be used in every withdraw request post.");
  }
  return;
}

if (m.indexOf("/picerr") === 0) {
  if (!hasOpts) { return; } // typed by a user -> ignore
  Bot.sendMessageToChatWithId(
    ADMIN_ID,
    "That picture link did not work. Use a direct image link (jpg / png), or send the picture itself.\n\nSend /withdrawpic to try again."
  );
  return;
}

// ---------- payout post sent: remember its message id ----------
if (m.indexOf("/grpposted") === 0) {
  if (hasResult && hasOpts && options.result) {
    var gRid = options.bb_options.rid;
    var gReq = getObj("wd_" + gRid);
    if (gReq) {
      gReq.gc = options.result.chat ? options.result.chat.id : PAYOUT_CHAT;
      gReq.gm = options.result.message_id;
      gReq.pt = options.bb_options.t === "t" ? "t" : "p";
      Bot.setProperty("wd_" + gRid, gReq, "json");
    }
  }
  return;
}

// ---------- payout post failed -> the request goes to the owner's DM ----------
if (m.indexOf("/grperror") === 0) {
  if (!hasOpts) { return; } // typed by a user -> ignore (no more admin spam)
  Bot.sendMessageToChatWithId(
    ADMIN_ID,
    "Could not post the withdraw request to the payout channel.\n\n" +
    "Check that:\n- the payout channel is set (/payout)\n- the bot is an admin of it\n- the withdraw picture works (/withdrawpic)\n\n" +
    "The request is sent to you below instead."
  );
  var eRid = options.bb_options.rid || "";
  var eReq = eRid ? getObj("wd_" + eRid) : null;
  if (eReq && eReq.s === "pending") { adminDm(eRid, eReq); }
  return;
}

function findUserId(t) {
  t = String(t || "").trim();
  if (/^\d+$/.test(t)) { return t; }
  var name = t.replace("@", "").toLowerCase();
  var found = Bot.getProperty("uname_" + name);
  return found ? String(found) : "";
}

// ---------- leaderboard storage: { userId: referralCount } ----------
function getLb() { return getObj("lb") || {}; }

function setLbEntry(id, count) {
  var lb = getLb();
  lb[String(id)] = count;
  var keys = Object.keys(lb);
  if (keys.length > 100) {
    keys.sort(function (a, b) { return lb[b] - lb[a]; });
    var nl = {};
    for (var k = 0; k < 60; k++) { nl[keys[k]] = lb[keys[k]]; }
    lb = nl;
  }
  Bot.setProperty("lb", lb, "json");
}

function showLeaderboard() {
  var myId = String(user.telegramid);
  var lb = getLb();
  var myRefs = num(Libs.ResourcesLib.userRes("refs").value());
  if (myRefs > 0 && lb[myId] !== myRefs) {
    setLbEntry(myId, myRefs);
    lb[myId] = myRefs;
  }
  var keys = Object.keys(lb).filter(function (k) { return lb[k] > 0; });
  keys.sort(function (a, b) { return lb[b] - lb[a]; });

  if (keys.length === 0) {
    Bot.sendMessage("LEADERBOARD\n\nNo referrals yet. Be the first one!");
    return;
  }

  var medals = ["1.", "2.", "3."];
  var text = "TOP REFERRERS\n\n";
  var top = Math.min(10, keys.length);
  for (var i = 0; i < top; i++) {
    var nm = Bot.getProperty("nm_" + keys[i]) || "User";
    var mark = i < 3 ? medals[i] : (i + 1) + ".";
    text += mark + " " + nm + " - " + lb[keys[i]] + " referrals\n";
  }
  var myPos = keys.indexOf(myId);
  if (myPos > -1) {
    text += "\nYour rank: #" + (myPos + 1) + " (" + lb[myId] + " referrals)";
  } else {
    text += "\nYou are not on the board yet. Share your link!";
  }
  Bot.sendMessage(text);
}

// ---------- public bot stats (everyone can see) ----------
function showPublicBotStats() {
  Bot.sendMessage(
    "BOT STATISTICS\n\n" +
    "Users started the bot: " + num(Bot.getProperty("total_users")) + "\n" +
    "Total stars paid: " + round2(num(Bot.getProperty("total_paid"))) + " Stars"
  );
}

// ---------- admin ----------
function adminPanel() {
  Bot.sendMessage(
    "ADMIN PANEL\n\n" +
    "Setup status:\n" +
    "Join channels: " + (CHANNELS.length > 0 ? CHANNELS.length + " added" : "none (use /addchannel)") + "\n" +
    "Payout channel: " + (PAYOUT_CHAT ? PAYOUT_CHAT + "" : "not set (use /payout)") + "\n" +
    "Withdraw picture: " + (WD_PIC ? "set" : "not set (use /withdrawpic)") + "\n\n" +
    "Balance manage:\n" +
    "/add +2 @username  -> add 2 stars\n" +
    "/add -2 @username  -> remove 2 stars\n" +
    "(you can also use the user ID instead of @username)\n\n" +
    "Broadcast:\n" +
    "/broadcast  -> send a message to all users\n\n" +
    "Join channels:\n" +
    "/addchannel  -> add a join channel\n" +
    "/removechannel  -> remove a join channel\n" +
    "(/add channel and /remove channel also work)\n\n" +
    "Payout channel:\n" +
    "/payout  -> set the channel/group where withdraw requests are posted\n" +
    "/payout remove  -> requests come to your DM instead\n\n" +
    "Withdraw picture:\n" +
    "/withdrawpic  -> set the picture shown in withdraw request posts\n" +
    "/withdrawpic remove  -> posts without a picture\n\n" +
    "Withdrawals:\n" +
    "/withdraw on  -> users can withdraw\n" +
    "/withdraw off  -> withdrawals closed\n" +
    "(/withdraw alone shows the current status)\n\n" +
    "Withdraw fee:\n" +
    "/fee + 1  -> increase the fee by 1 star\n" +
    "/fee - 1  -> decrease the fee by 1 star\n" +
    "(/fee alone shows the current fee)\n\n" +
    "Referral reward:\n" +
    "/ref 1  -> set stars per referral\n" +
    "/ref 0.5  -> set 0.5 stars per referral\n" +
    "(/ref alone shows the current reward)\n\n" +
    "Withdraw limits:\n" +
    "/min 1  -> set minimum withdraw\n" +
    "/max 100  -> set maximum withdraw\n" +
    "(/min or /max alone shows the current value)\n\n" +
    "Detailed bot statistics:\n" +
    "/botstats  -> users, stars paid, requests\n\n" +
    "Set public stats numbers:\n" +
    "/setstats users 150  -> set users count\n" +
    "/setstats paid 40  -> set total stars paid\n\n" +
    "/cancel  -> cancel current action"
  );
}

function showBotStats() {
  Bot.sendMessage(
    "BOT STATISTICS (admin)\n\n" +
    "Users started the bot: " + num(Bot.getProperty("total_users")) + "\n" +
    "Verified users: " + num(Bot.getProperty("total_verified")) + "\n" +
    "Withdrawals: " + (WD_ON ? "OPEN" : "CLOSED") + "\n" +
    "Withdraw fee: " + FEE + " Stars\n" +
    "Referral reward: " + REWARD + " Stars\n\n" +
    "Withdraw requests: " + num(Bot.getProperty("wd_total")) + "\n" +
    "Pending: " + num(Bot.getProperty("wd_pending")) + "\n" +
    "Approved: " + num(Bot.getProperty("wd_approved")) + "\n" +
    "Rejected: " + num(Bot.getProperty("wd_rejected")) + "\n\n" +
    "Total stars paid: " + round2(num(Bot.getProperty("total_paid"))) + " Stars"
  );
}

// ---------- withdraw request post (photo + details, or text if no picture is set) ----------
function buildCaption(name, uname, amount, link, fee) {
  fee = num(fee);
  return "<b>NEW WITHDRAW REQUEST</b>\n\n" +
    "<b>User:</b> " + esc(name) + (uname ? " (" + esc(uname) + ")" : "") + "\n" +
    "<b>Stars:</b> " + amount + "\n" +
    (fee > 0 ? "<b>Fee:</b> " + fee + " Stars\n<b>Payout:</b> " + round2(amount - fee) + " Stars\n" : "") +
    (link ? "<b>Post:</b> " + esc(link) + "\n" : "") + "\n" +
    "Start the bot & earn more: @" + bot.name + "\n" +
    "Contact admin: @" + ADMIN_USERNAME;
}

function wdButtons(rid) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: "/wd_ok " + rid },
      { text: "Reject", callback_data: "/wd_no " + rid }
    ]]
  };
}

function postToGroup(rid, name, uname, amount, link, fee) {
  if (WD_PIC) {
    Api.sendPhoto({
      chat_id: PAYOUT_CHAT,
      photo: WD_PIC,
      caption: buildCaption(name, uname, amount, link, fee),
      parse_mode: "HTML",
      reply_markup: wdButtons(rid),
      on_result: "/grpposted",
      on_error: "/grperror",
      bb_options: { rid: rid, t: "p" }
    });
  } else {
    Api.sendMessage({
      chat_id: PAYOUT_CHAT,
      text: buildCaption(name, uname, amount, link, fee),
      parse_mode: "HTML",
      reply_markup: wdButtons(rid),
      on_result: "/grpposted",
      on_error: "/grperror",
      bb_options: { rid: rid, t: "t" }
    });
  }
}

// no payout channel set (or posting failed): the request goes to the owner's DM
function adminDm(rid, req) {
  Api.sendMessage({
    chat_id: ADMIN_ID,
    text: "Withdraw request #" + rid + "\n\nUser: " + req.n + " (" + req.u + ")\nID: " + req.uid +
      "\nAmount: " + req.amt + " Stars" +
      (feeOf(req) > 0 ? "\nFee: " + feeOf(req) + " Stars\nPayout: " + netOf(req) + " Stars" : "") +
      (req.l ? "\nPost: " + req.l : ""),
    reply_markup: wdButtons(rid)
  });
}

// after Approve / Reject: remove the buttons and show the result text in the group post
function updateGroupPost(req, statusLine) {
  if (!req.gc || !req.gm) { return; }
  var un = (req.u && req.u !== "no username") ? req.u : "";
  var cap = buildCaption(req.n, un, req.amt, req.l, feeOf(req)) + "\n\n" + statusLine;
  if (req.pt === "t") {
    Api.editMessageText({
      chat_id: req.gc,
      message_id: req.gm,
      text: cap,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  } else {
    Api.editMessageCaption({
      chat_id: req.gc,
      message_id: req.gm,
      caption: cap,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  }
}

// ---------- main user flows ----------
// join buttons: all channels, or only the given channel indexes (the ones the user is missing)
function joinRows(only) {
  var rows = [];
  for (var c = 0; c < CHANNELS.length; c++) {
    if (only && only.indexOf(c) === -1) { continue; }
    var cn = CHANNELS[c];
    rows.push([{ text: "Join " + cn + "", url: "https://t.me/" + String(cn).replace("@", "") }]);
  }
  rows.push([{ text: "Joined", callback_data: "/verify" }]);
  return rows;
}

function showJoin() {
  var text =
    "<b>WELCOME TO STAR EARN</b>\n\n" +
    "<b>EARNINGS INFO:</b>\n" +
    "- Per Referral: " + REWARD + " Stars\n" +
    "- Min. Withdraw: " + MIN_WITHDRAW + " Star\n" +
    "- Max. Withdraw: " + MAX_WITHDRAW + " Stars\n\n" +
    "<b>INSTRUCTIONS:</b>\n" +
    "Please join all our channels & groups below and click the button to unlock your dashboard!";
  Api.sendMessage({
    text: text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: joinRows() }
  });
}

// mark the user as verified (+ referral reward)
function markVerified() {
  if (User.getProperty("verified")) { return; }
  User.setProperty("verified", true, "boolean");
  bump("total_verified", 1);
  var ref = User.getProperty("ref_by");
  if (ref) {
    Libs.ResourcesLib.anotherUserRes("balance", ref).add(REWARD);
    var refRes = Libs.ResourcesLib.anotherUserRes("refs", ref);
    refRes.add(1);
    setLbEntry(ref, num(refRes.value()));
    Bot.sendMessageToChatWithId(ref, "New referral joined! You earned +" + REWARD + " Stars");
  }
}

// the user is inside every channel
// act = the message the user sent before the check (it is run again), "" if none
function joinedAll(act) {
  User.setProperty("joined_ok", true, "boolean");
  User.setProperty("chk_ts", Date.now(), "integer");
  if (User.getProperty("verified")) {
    if (act) { Bot.runCommand(act); } else { showMenu(); }
  } else {
    markVerified();
    showMenu();
  }
}

// membership check in BATCHES.
// Bots.Business allows max 5 commands in one chain, so only CHECK_BATCH channels are checked per chain.
// When a batch is finished, the next batch is started with Bot.run (a new chain), so any number of channels works.
var CHECK_BATCH = 3;

// act = the message the user sent before the check (it is run again), "" if none
function startCheck(act) {
  var rid = String(Date.now());
  User.setProperty("chk_act", act || "", "string");
  User.setProperty("chk_rid", rid, "string");
  User.setProperty("chk_pending", "", "string");
  runBatch(0, rid);
}

function runBatch(start, rid) {
  var end = Math.min(start + CHECK_BATCH, CHANNELS.length);
  for (var c = start; c < end; c++) {
    Api.getChatMember({
      chat_id: CHANNELS[c],
      user_id: user.telegramid,
      on_result: "/chkresult",
      on_error: "/chkerror",
      bb_options: { i: c, n: CHANNELS.length, rid: rid, st: start, en: end }
    });
  }
}

// called after every single channel answer of a batch
function afterAnswer(rid, n, st, en) {
  for (var q = st; q < en; q++) {
    var v = String(User.getProperty("cm_" + q) || "");
    if (v.indexOf(rid + ":") !== 0) { return; } // still waiting for other channels of this batch
  }
  var claim = rid + ":" + st;
  if (String(User.getProperty("chk_bd")) === claim) { return; } // this batch was already handled
  User.setProperty("chk_bd", claim, "string");

  if (en < n) {
    // more channels left -> next batch in a NEW chain
    User.setProperty("chk_pending", rid + ":" + en, "string");
    Bot.run({ command: "/chknext", run_after: 1 });
    return;
  }
  decideAll(n, String(User.getProperty("chk_act") || ""));
}

// all batches are done -> decide
function decideAll(n, act) {
  var miss = [];
  var errNames = [];
  for (var q = 0; q < n; q++) {
    var st = String(User.getProperty("cm_" + q) || "").split(":")[1];
    if (st === "0") { miss.push(q); } else if (st !== "1") { errNames.push(CHANNELS[q] || "channel"); }
  }

  if (miss.length > 0) {
    User.setProperty("chk_ts", 0, "integer"); // stay locked until they join again
    var missNames = "";
    for (var qq = 0; qq < miss.length; qq++) { missNames += "- " + CHANNELS[miss[qq]] + "\n"; }
    var missText = User.getProperty("verified")
      ? "<b>You left some channels!</b>\n\nPlease join these again to keep using the bot:\n\n" + missNames + "\nThen press <b>Joined</b>."
      : "<b>You have not joined all channels yet.</b>\n\nPlease join these:\n\n" + missNames + "\nThen press <b>Joined</b> again.";
    Api.sendMessage({
      text: missText,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: joinRows(miss) }
    });
    return;
  }

  if (errNames.length > 0) {
    // usually: the bot is NOT an admin of that channel / the channel was deleted
    if (Date.now() - num(Bot.getProperty("chk_warn_ts")) > 600000) {
      Bot.setProperty("chk_warn_ts", Date.now(), "integer");
      Bot.sendMessageToChatWithId(
        ADMIN_ID,
        "Membership check failed for: " + errNames.join(", ") + "\n\nUsers cannot pass the join check until this is fixed.\n- Make sure the bot is an ADMIN of that channel/group\n- Or remove it with /removechannel"
      );
    }
    Bot.sendMessage("Could not check membership. Please try again in a moment.");
    return;
  }

  joinedAll(act);
}

// true when this user passed the channel check recently
function checkFresh() {
  return (Date.now() - num(User.getProperty("chk_ts"))) < CHECK_TTL;
}

function showMenu() {
  Bot.sendKeyboard(
    "Balance,Referral\nWithdraw,Stats\nLeaderboard,Bot Stats",
    "Dashboard unlocked! Choose an option below"
  );
}

function notVerifiedYet() {
  if (CHANNELS.length === 0) {
    // no join channels set yet -> nothing to check
    joinedAll("");
  } else if (User.getProperty("joined_ok")) {
    startCheck("");
  } else {
    showJoin();
  }
}

// step 1: user pressed Withdraw -> ask for the amount (no fee info shown)
function startWithdraw() {
  // withdrawals closed by admin (/withdraw off)
  if (!WD_ON) {
    User.setProperty("wd_state", "none", "string");
    Bot.sendMessage(WD_CLOSED_MSG);
    return;
  }
  var bal = num(Libs.ResourcesLib.userRes("balance").value());
  if (bal < MIN_WITHDRAW || bal <= FEE) {
    Bot.sendMessage(
      "You need more balance to withdraw.\n" +
      "Minimum withdraw is " + MIN_WITHDRAW + " Star.\nYour balance: " + bal + ""
    );
    return;
  }
  User.setProperty("wd_state", "amount", "string");
  Bot.sendMessage(
    "Enter the amount you want to withdraw.\n\n" +
    "Minimum: " + MIN_WITHDRAW + " Star\n" +
    "Maximum: " + MAX_WITHDRAW + " Stars\n" +
    "Your balance: " + bal + " Stars\n\n" +
    "(Tap any menu button to cancel)"
  );
}

// step 3: amount + post link are ready -> create the request
function createWithdraw(amount, link) {
  // safety: withdrawals closed while the user was still typing
  if (!WD_ON) {
    User.setProperty("wd_state", "none", "string");
    Bot.sendMessage(WD_CLOSED_MSG);
    return;
  }
  var res = Libs.ResourcesLib.userRes("balance");
  if (amount < MIN_WITHDRAW || amount > MAX_WITHDRAW || amount > num(res.value()) || amount <= FEE) {
    Bot.sendMessage("Could not create the withdraw request. Please press Withdraw and try again.");
    return;
  }

  var uname = user.username ? "@" + user.username : "no username";
  var fname = user.first_name || "Unknown";

  // fee is taken from the withdrawn amount
  var fee = FEE;
  var net = round2(amount - fee);

  var rid = num(Bot.getProperty("wd_counter")) + 1;
  Bot.setProperty("wd_counter", rid, "integer");
  var reqObj = {
    uid: String(user.telegramid),
    amt: amount,
    f: fee,
    net: net,
    n: fname,
    u: uname,
    l: link,
    s: "pending"
  };
  Bot.setProperty("wd_" + rid, reqObj, "json");
  bump("wd_total", 1);
  bump("wd_pending", 1);

  res.remove(amount);
  User.setProperty("wd_state", "none", "string");

  // confirmation to the user (no fee info)
  var okMsg = {
    text: "<b>Withdraw request #" + rid + "</b> sent!\n\n" +
      "Withdraw: <b>" + amount + " Stars</b>\n" +
      "\nAdmin will review it soon." +
      (PAYOUT_LINK ? "\n\nCheck the payout channel:\n" + PAYOUT_LINK : ""),
    parse_mode: "HTML"
  };
  if (PAYOUT_LINK) {
    okMsg.reply_markup = { inline_keyboard: [[{ text: "Check Payout Channel", url: PAYOUT_LINK }]] };
  }
  Api.sendMessage(okMsg);

  // payout channel set -> post there (fee shown in the post). Not set -> the owner gets it in DM
  if (PAYOUT_CHAT) {
    postToGroup(rid, fname, user.username ? "@" + user.username : "", amount, link, fee);
  } else {
    adminDm(rid, reqObj);
  }
}

// ===== ADMIN COMMANDS =====
var cmd = m.split(/\s+/)[0].toLowerCase();
var cw = m.trim().split(/\s+/);
var chArg = "";
if ((cmd === "/add" || cmd === "/remove") && (cw[1] || "").toLowerCase() === "channel") {
  cmd = (cmd === "/add") ? "/addchannel" : "/removechannel";
  chArg = cw[2] || "";
} else if (cmd === "/addchannel" || cmd === "/removechannel") {
  chArg = cw[1] || "";
}
if (cmd === "/setwithdrawpic") { cmd = "/withdrawpic"; }

if (cmd === "/admin" || cmd === "/add" || cmd === "/broadcast" || cmd === "/cancel" ||
    cmd === "/botstats" || cmd === "/setstats" || cmd === "/wd_ok" || cmd === "/wd_no" ||
    cmd === "/min" || cmd === "/max" || cmd === "/addchannel" || cmd === "/removechannel" ||
    cmd === "/fee" || cmd === "/ref" || cmd === "/withdraw" ||
    cmd === "/payout" || cmd === "/withdrawpic") {
  if (!isAdmin) { return; } // everyone else is ignored
}

if (isAdmin) {
  if (cmd === "/admin") {
    adminPanel();
    return;
  }

  if (cmd === "/botstats") {
    showBotStats();
    return;
  }

  // payout channel/group: /payout , /payout https://t.me/name , /payout remove
  if (cmd === "/payout") {
    var poArg = (cw[1] || "").trim();
    if (poArg.toLowerCase() === "remove" || poArg.toLowerCase() === "off") {
      Bot.setProperty("payout_chat", "", "string");
      User.setProperty("admin_state", "none", "string");
      Bot.sendMessage("Payout channel removed.\n\nWithdraw requests will now come to your DM with Approve / Reject buttons.");
      return;
    }
    if (!poArg) {
      User.setProperty("admin_state", "payout", "string");
      Bot.sendMessage(
        "Enter the link of the channel/group where withdraw requests will be posted.\n\n" +
        "Example:\nhttps://t.me/yourchannel\n\n" +
        "Current: " + (PAYOUT_CHAT ? PAYOUT_CHAT : "not set") + "\n\n" +
        "- It must be a PUBLIC channel/group\n- The bot must be an ADMIN there\n(/cancel to stop)"
      );
      return;
    }
    var poN = parseChannel(poArg);
    if (!poN) {
      Bot.sendMessage("Invalid link. Send a public channel/group link like:\nhttps://t.me/yourchannel");
      return;
    }
    User.setProperty("admin_state", "none", "string");
    startPayoutTest(poN);
    return;
  }

  // withdraw picture: /withdrawpic , /withdrawpic https://image-link , /withdrawpic remove
  if (cmd === "/withdrawpic") {
    var wpArg = (cw[1] || "").trim();
    if (wpArg.toLowerCase() === "remove" || wpArg.toLowerCase() === "off") {
      Bot.setProperty("wd_pic", "", "string");
      User.setProperty("admin_state", "none", "string");
      Bot.sendMessage("Withdraw picture removed.\n\nWithdraw requests will be posted as text only.");
      return;
    }
    if (!wpArg) {
      User.setProperty("admin_state", "wdpic", "string");
      Bot.sendMessage(
        "Send the picture for withdraw request posts.\n\n" +
        "You can:\n" +
        "1. Send the picture itself (as a normal photo)\n" +
        "2. Or send a direct image link (jpg / png)\n\n" +
        "Current: " + (WD_PIC ? "set" : "not set") + "\n\n" +
        "(/cancel to stop)"
      );
      return;
    }
    if (!/^https?:\/\/\S+$/i.test(wpArg)) {
      Bot.sendMessage("That is not a valid link. Send a direct image link, or use /withdrawpic and send the picture itself.");
      return;
    }
    User.setProperty("admin_state", "none", "string");
    Api.sendPhoto({
      photo: wpArg,
      caption: "Picture preview. Saving...",
      on_result: "/picok",
      on_error: "/picerr",
      bb_options: { pic: wpArg }
    });
    return;
  }

  // withdrawals ON / OFF
  if (cmd === "/withdraw") {
    var wdArg = (cw[1] || "").toLowerCase();
    if (wdArg === "on") {
      Bot.setProperty("wd_off", "0", "string");
      Bot.sendMessage("Withdrawals are now OPEN.\n\nUsers can withdraw normally.");
    } else if (wdArg === "off") {
      Bot.setProperty("wd_off", "1", "string");
      Bot.sendMessage("Withdrawals are now CLOSED.\n\nUsers will see: \"" + WD_CLOSED_MSG + "\"");
    } else {
      Bot.sendMessage(
        "Withdrawals are currently: " + (WD_ON ? "OPEN" : "CLOSED") + "\n\n" +
        "/withdraw on  -> open\n/withdraw off  -> close"
      );
    }
    return;
  }

  // referral reward per referral: /ref 1 , /ref 0.5 , /ref (show)
  if (cmd === "/ref") {
    var refArg = (cw[1] || "").trim();
    if (!refArg) {
      Bot.sendMessage(
        "Current referral reward: " + REWARD + " Stars per referral\n\n" +
        "To change it:\n/ref 1\n/ref 0.5"
      );
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(refArg) || parseFloat(refArg) <= 0 || parseFloat(refArg) > 1000) {
      Bot.sendMessage("Usage:\n/ref 1  -> 1 star per referral\n/ref 0.5  -> 0.5 stars per referral");
      return;
    }
    var newReward = round2(parseFloat(refArg));
    if (newReward <= 0) {
      Bot.sendMessage("Reward must be at least 0.01 Stars.");
      return;
    }
    var oldReward = REWARD;
    Bot.setProperty("ref_reward", newReward, "float");
    Bot.sendMessage(
      "Referral reward updated\n\n" +
      "Old reward: " + oldReward + " Stars\nNew reward: " + newReward + " Stars per referral\n\n" +
      "Applies to new referrals from now on."
    );
    return;
  }

  // withdraw fee: /fee + 1  (increase) , /fee - 1  (decrease) , /fee  (show)
  if (cmd === "/fee") {
    var feeRest = m.trim().replace(/^\S+\s*/, "").replace(/\s+/g, "");
    if (!feeRest) {
      Bot.sendMessage(
        "Current withdraw fee: " + FEE + " Stars\n\n" +
        "/fee + 1  -> increase by 1\n/fee - 1  -> decrease by 1"
      );
      return;
    }
    var feeM = feeRest.match(/^([+-])(\d+(?:\.\d+)?)$/);
    if (!feeM || parseFloat(feeM[2]) <= 0) {
      Bot.sendMessage("Usage:\n/fee + 1  -> increase the fee by 1\n/fee - 1  -> decrease the fee by 1");
      return;
    }
    var feeChange = parseFloat(feeM[2]);
    var newFee = feeM[1] === "+" ? FEE + feeChange : FEE - feeChange;
    var feeNote = "";
    if (newFee < 0) { newFee = 0; feeNote = "\n(Fee cannot go below 0)"; }
    newFee = round2(newFee);
    Bot.setProperty("wd_fee", newFee, "float");
    Bot.sendMessage(
      "Withdraw fee updated\n\n" +
      "Old fee: " + FEE + " Stars\nNew fee: " + newFee + " Stars" + feeNote +
      (newFee > 0 ? "\n\nExample: user withdraws " + round2(newFee + 1) + " Stars -> pays " + newFee + " fee -> receives 1 Star." : "")
    );
    return;
  }

  // add / remove a join channel
  if (cmd === "/addchannel" || cmd === "/removechannel") {
    var chAdd = (cmd === "/addchannel");
    if (!chArg) {
      User.setProperty("admin_state", chAdd ? "addchannel" : "removechannel", "string");
      if (chAdd) {
        Bot.sendMessage("Enter the channel link to add.\n\nExample:\nhttps://t.me/yourchannel\n\n(The bot must be an admin of that channel)\n(/cancel to stop)");
      } else {
        Bot.sendMessage("Enter the link of the channel to remove.\n\nCurrent channels:\n" + channelListText() + "\n\n(/cancel to stop)");
      }
      return;
    }
    var chN = parseChannel(chArg);
    if (!chN) {
      Bot.sendMessage("Invalid link. Send a public channel/group link like:\nhttps://t.me/yourchannel");
      return;
    }
    if (chAdd) { startAddChannel(chN); } else { removeChannel(chN); }
    return;
  }

  // set minimum / maximum withdraw amount
  if (cmd === "/min" || cmd === "/max") {
    var isMin = (cmd === "/min");
    var lim = m.trim().split(/\s+/)[1] || "";
    if (!lim) {
      Bot.sendMessage(
        "Current " + (isMin ? "minimum" : "maximum") + " withdraw: " + (isMin ? MIN_WITHDRAW : MAX_WITHDRAW) + " Stars\n\n" +
        "To change it:\n" + cmd + " " + (isMin ? "1" : "100")
      );
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(lim) || parseFloat(lim) <= 0) {
      Bot.sendMessage("Usage:\n" + cmd + " " + (isMin ? "1" : "100"));
      return;
    }
    var limVal = round2(parseFloat(lim));
    if (isMin && limVal > MAX_WITHDRAW) {
      Bot.sendMessage("Minimum cannot be higher than the maximum (" + MAX_WITHDRAW + "). Change /max first.");
      return;
    }
    if (!isMin && limVal < MIN_WITHDRAW) {
      Bot.sendMessage("Maximum cannot be lower than the minimum (" + MIN_WITHDRAW + "). Change /min first.");
      return;
    }
    Bot.setProperty(isMin ? "min_wd" : "max_wd", limVal, "float");
    Bot.sendMessage("" + (isMin ? "Minimum" : "Maximum") + " withdraw set to " + limVal + " Stars.\nUsers will see the new limit now.");
    return;
  }

  // set the numbers shown in public bot stats
  if (cmd === "/setstats") {
    var sp = m.trim().split(/\s+/);
    var what = (sp[1] || "").toLowerCase();
    var val = sp[2] || "";
    if ((what !== "users" && what !== "paid") || !/^\d+(\.\d+)?$/.test(val)) {
      Bot.sendMessage("Usage:\n/setstats users 150\n/setstats paid 40");
      return;
    }
    if (what === "users") {
      Bot.setProperty("total_users", Math.round(parseFloat(val)), "integer");
      Bot.sendMessage("Users count set to " + Math.round(parseFloat(val)));
    } else {
      Bot.setProperty("total_paid", round2(parseFloat(val)), "float");
      Bot.sendMessage("Total stars paid set to " + round2(parseFloat(val)));
    }
    return;
  }

  // approve / reject withdraw request
  if (cmd === "/wd_ok" || cmd === "/wd_no") {
    var rid2 = m.trim().split(/\s+/)[1] || "";
    var req = getObj("wd_" + rid2);
    if (!req) {
      Bot.sendMessage("Request #" + rid2 + " not found.");
      return;
    }
    if (req.s !== "pending") {
      Bot.sendMessage("Request #" + rid2 + " is already " + req.s + ".");
      return;
    }

    if (cmd === "/wd_ok") {
      // status is saved FIRST, so a second click right after sees "approved" and stops
      req.s = "approved";
      Bot.setProperty("wd_" + rid2, req, "json");
      bump("wd_pending", -1);
      bump("wd_approved", 1);
      bump("total_paid", netOf(req), "float");
      Bot.sendMessageToChatWithId(
        req.uid,
        "Admin approved your withdrawal request of " + req.amt + " Stars\nYour payment is on the way!"
      );
      updateGroupPost(req, "<b>APPROVED</b>");
      if (cid >= 0) {
        Bot.sendMessage(
          "Request #" + rid2 + " APPROVED\n" + req.n + " (" + req.u + ")\n" + req.amt + " Stars" +
          (feeOf(req) > 0 ? "\nFee: " + feeOf(req) + " Stars\nPayout: " + netOf(req) + " Stars" : "") +
          "\n\nUser has been notified."
        );
      }
    } else {
      req.s = "rejected";
      Bot.setProperty("wd_" + rid2, req, "json");
      bump("wd_pending", -1);
      bump("wd_rejected", 1);
      // give the full stars back, they were deducted when the request was made
      Libs.ResourcesLib.anotherUserRes("balance", req.uid).add(num(req.amt));
      Bot.sendMessageToChatWithId(req.uid, "Your withdrawal request of " + req.amt + " Stars was rejected by admin.\nThe " + req.amt + " Stars have been returned to your balance.");
      updateGroupPost(req, "<b>REJECTED</b>");
      if (cid >= 0) {
        Bot.sendMessage("Request #" + rid2 + " REJECTED\n" + req.n + " (" + req.u + ")\n" + req.amt + " Stars returned to the user's balance.\n\nUser has been notified.");
      }
    }
    return;
  }

  if (cmd === "/broadcast") {
    User.setProperty("admin_state", "broadcast", "string");
    Bot.sendMessage("Broadcast\n\nSend your message to forward to all users.\n\n(/cancel to stop)");
    return;
  }

  if (cmd === "/cancel") {
    User.setProperty("admin_state", "none", "string");
    User.setProperty("wd_state", "none", "string");
    Bot.sendMessage("Cancelled.");
    return;
  }

  if (cmd === "/add") {
    var parts = m.trim().split(/\s+/);
    var amtStr = parts[1] || "";
    var target = parts[2] || "";
    if (!/^[+-]?\d+(\.\d+)?$/.test(amtStr) || !target) {
      Bot.sendMessage("Usage:\n/add +2 @username\n/add -2 @username\n/add +2 123456789");
      return;
    }
    var amt = round2(parseFloat(amtStr));
    var tid = findUserId(target);
    if (!tid) {
      Bot.sendMessage("User not found.\n\nUse their numeric ID, or ask them to send any message to the bot so their @username gets saved.");
      return;
    }
    var bres = Libs.ResourcesLib.anotherUserRes("balance", tid);
    var before = num(bres.value());
    var applied = amt >= 0 ? amt : -Math.min(-amt, before);
    if (applied > 0) { bres.add(applied); }
    if (applied < 0) { bres.remove(-applied); }
    var after = round2(before + applied);
    var sign = applied >= 0 ? "+" : "";
    var note = (amt < 0 && -amt > before) ? "\n(Balance cannot go below 0)" : "";
    Bot.sendMessage(
      "Balance updated\n\nUser: " + target + "\nID: " + tid +
      "\nChange: " + sign + applied + "\nNew balance: " + after + "" + note
    );
    if (applied !== 0) {
      Bot.sendMessageToChatWithId(tid, "Your balance was updated by admin: " + sign + applied + "\nNew balance: " + after + "");
    }
    return;
  }

  var adSt = User.getProperty("admin_state");

  // admin sent the withdraw picture (photo or link) after /withdrawpic
  if (adSt === "wdpic" && !hasResult && !hasContent) {
    if (hasPhoto) {
      var fileId = request.photo[request.photo.length - 1].file_id;
      Bot.setProperty("wd_pic", String(fileId), "string");
      User.setProperty("admin_state", "none", "string");
      Api.sendPhoto({
        photo: fileId,
        caption: "Withdraw picture saved.\n\nThis picture will be used in every withdraw request post."
      });
      return;
    }
    if (m && m.charAt(0) !== "/") {
      if (!/^https?:\/\/\S+$/i.test(m.trim())) {
        Bot.sendMessage("Send the picture itself, or a direct image link (jpg / png).\n\n(/cancel to stop)");
        return;
      }
      User.setProperty("admin_state", "none", "string");
      Api.sendPhoto({
        photo: m.trim(),
        caption: "Picture preview. Saving...",
        on_result: "/picok",
        on_error: "/picerr",
        bb_options: { pic: m.trim() }
      });
      return;
    }
  }

  // admin sent the payout channel link (after /payout)
  if (adSt === "payout" && m.length > 0 && m.charAt(0) !== "/" && !hasResult && !hasContent) {
    var poName = parseChannel(m);
    if (!poName) {
      Bot.sendMessage("Invalid link. Send a public channel/group link like:\nhttps://t.me/yourchannel\n\n(/cancel to stop)");
      return;
    }
    User.setProperty("admin_state", "none", "string");
    startPayoutTest(poName);
    return;
  }

  // admin sent the channel link (after /addchannel or /removechannel)
  if ((adSt === "addchannel" || adSt === "removechannel") && m.length > 0 && m.charAt(0) !== "/" && !hasResult && !hasContent) {
    var chName = parseChannel(m);
    if (!chName) {
      Bot.sendMessage("Invalid link. Send a public channel/group link like:\nhttps://t.me/yourchannel\n\n(/cancel to stop)");
      return;
    }
    User.setProperty("admin_state", "none", "string");
    if (adSt === "addchannel") { startAddChannel(chName); } else { removeChannel(chName); }
    return;
  }

  // admin typed the broadcast message
  if (adSt === "broadcast" && m.length > 0 && m.charAt(0) !== "/" && !hasResult && !hasContent) {
    User.setProperty("admin_state", "none", "string");
    Bot.setProperty("bc_text", m, "string");
    Bot.runAll({ command: "/__bc" });
    Bot.sendMessage("Message sent successfully to all users!");
    return;
  }
}

// 0) next batch of the membership check (started by Bot.run, only runs if a batch is really waiting)
if (m.indexOf("/chknext") === 0) {
  var pend = String(User.getProperty("chk_pending") || "");
  if (!pend) { return; } // typed by a user / nothing waiting -> ignore
  User.setProperty("chk_pending", "", "string");
  var pp = pend.split(":");
  runBatch(num(pp[1]), pp[0]);
  return;
}

// 1) result of membership check (real API callbacks only)
if (hasResult && hasOpts && options.bb_options.rid !== undefined) {
  var cRid = String(options.bb_options.rid);
  if (cRid !== String(User.getProperty("chk_rid"))) { return; } // answer of an old, replaced check
  var ci = num(options.bb_options.i);
  var status = options.result.status;
  var joined = ["member", "administrator", "creator"].indexOf(status) > -1;
  User.setProperty("cm_" + ci, cRid + ":" + (joined ? "1" : "0"), "string");
  afterAnswer(cRid, num(options.bb_options.n), num(options.bb_options.st), num(options.bb_options.en));
  return;
}

// 2) membership check error for one channel
// (usually: the bot is NOT an admin of that channel / the channel was deleted)
if (m.indexOf("/chkerror") === 0) {
  if (!hasOpts || options.bb_options.rid === undefined) { return; } // typed by a user -> ignore
  var eRid2 = String(options.bb_options.rid);
  if (eRid2 !== String(User.getProperty("chk_rid"))) { return; }
  User.setProperty("cm_" + num(options.bb_options.i), eRid2 + ":e", "string");
  afterAnswer(eRid2, num(options.bb_options.n), num(options.bb_options.st), num(options.bb_options.en));
  return;
}

// 3) /start
if (m.indexOf("/start") === 0) {
  User.setProperty("wd_state", "none", "string");
  var refId = m.split(" ")[1];

  // "Open admin panel" button of the creator bot (https://t.me/BOT?start=admin)
  if (refId === "admin" && isAdmin) {
    adminPanel();
    return;
  }

  if (!User.getProperty("started")) {
    User.setProperty("started", true, "boolean");
    bump("total_users", 1);
    var invitedBy = "";
    // referral id must be a plain number and not the user's own id
    if (refId && /^\d+$/.test(String(refId)) && String(refId) !== String(user.telegramid)) {
      User.setProperty("ref_by", String(refId), "string");
      invitedBy = String(refId);
    }

    // tell the admin about the new user
    var who = (user.first_name || "Unknown") + (user.last_name ? " " + user.last_name : "");
    Bot.sendMessageToChatWithId(
      ADMIN_ID,
      "New user started the bot\n\n" +
      "Name: " + who + "\n" +
      "Username: " + (user.username ? "@" + user.username : "no username") + "\n" +
      "ID: " + user.telegramid +
      (invitedBy ? "\nReferred by ID: " + invitedBy : "")
    );
  }
  if (User.getProperty("verified") || isAdmin) {
    // check that they are still in every channel before showing the menu (owner is never checked)
    if (CHANNELS.length > 0 && !isAdmin) { startCheck(""); } else { showMenu(); }
  } else {
    notVerifiedYet();
  }
  return;
}

// 4) Joined button
if (m.indexOf("/verify") === 0) {
  if (CHANNELS.length === 0) {
    joinedAll("");
    return;
  }
  startCheck("");
  return;
}

// everything below needs verified user (the owner is always allowed)
if (!User.getProperty("verified") && !isAdmin) {
  notVerifiedYet();
  return;
}

// verified user is still inside every channel? (checked again after CHECK_TTL)
if (CHANNELS.length > 0 && !isAdmin && !checkFresh()) {
  startCheck(m);
  return;
}

// withdraw steps: the user types the amount, then the post link
var wdState = User.getProperty("wd_state");
if (wdState === "amount" || wdState === "link") {
  var isMenuTap = m.trim().length <= 16 && /(Balance|Referral|Withdraw|Stats|Leaderboard)/.test(m);
  if (isMenuTap || m.charAt(0) === "/") {
    // user pressed a menu button -> cancel the withdraw steps and handle the button below
    User.setProperty("wd_state", "none", "string");
  } else if (!WD_ON) {
    // withdrawals were closed while the user was typing
    User.setProperty("wd_state", "none", "string");
    Bot.sendMessage(WD_CLOSED_MSG);
    return;
  } else if (wdState === "amount") {
    var tAmt = m.trim();
    if (!/^\d+(\.\d+)?$/.test(tAmt)) {
      Bot.sendMessage("Please send the amount as a number.\nExample: 5");
      return;
    }
    var wAmt = round2(parseFloat(tAmt));
    var wBal = num(Libs.ResourcesLib.userRes("balance").value());
    if (wAmt < MIN_WITHDRAW) {
      Bot.sendMessage("Minimum withdraw is " + MIN_WITHDRAW + " Star.");
      return;
    }
    if (wAmt > MAX_WITHDRAW) {
      Bot.sendMessage("Maximum withdrawal amount is " + MAX_WITHDRAW + " Stars.");
      return;
    }
    if (wAmt <= FEE) {
      Bot.sendMessage("Please enter a higher amount.");
      return;
    }
    if (wAmt > wBal) {
      Bot.sendMessage("Not enough balance.\nYour balance: " + wBal + "");
      return;
    }
    User.setProperty("wd_amt", wAmt, "float");
    User.setProperty("wd_state", "link", "string");
    Bot.sendMessage("Enter your post link.\n\nExample:\nhttps://t.me/yourchannel/123");
    return;
  } else {
    var wLink = m.trim();
    var okLink = /^https?:\/\/(t\.me|telegram\.me)\/(c\/\d+|[A-Za-z][A-Za-z0-9_]{3,31})\/\d+(\/\d+)?(\?\S*)?$/i.test(wLink);
    if (!okLink) {
      Bot.sendMessage("Invalid post link style.\n\nPlease send a Telegram post link like this:\nhttps://t.me/yourchannel/123");
      return;
    }
    var wAmt2 = num(User.getProperty("wd_amt"));
    User.setProperty("wd_state", "none", "string");
    createWithdraw(wAmt2, wLink);
    return;
  }
}

// 5) menu buttons
if (m.indexOf("Leaderboard") > -1) {
  showLeaderboard();
  return;
}

// must be checked before "Stats" (personal stats)
if (m.indexOf("Bot Stats") > -1) {
  showPublicBotStats();
  return;
}

if (m.indexOf("Balance") > -1) {
  var bal = Libs.ResourcesLib.userRes("balance").value();
  Bot.sendMessage("<b>Your Balance:</b> " + bal + " Stars", { parse_mode: "HTML" });
  return;
}

if (m.indexOf("Referral") > -1) {
  var link = "https://t.me/" + bot.name + "?start=" + user.telegramid;
  Bot.sendMessage(
    "<b>Share this link to earn stars!</b>\n\n" + link +
    "\n\nYou get " + REWARD + " Stars for every friend who joins all channels.",
    { parse_mode: "HTML" }
  );
  return;
}

if (m.indexOf("Stats") > -1) {
  var refs = Libs.ResourcesLib.userRes("refs").value();
  var bal2 = Libs.ResourcesLib.userRes("balance").value();
  Bot.sendMessage(
    "<b>Your Stats</b>\n\nReferrals: " + refs + "\nBalance: " + bal2 + " Stars",
    { parse_mode: "HTML" }
  );
  return;
}

if (m.indexOf("Withdraw") > -1) {
  startWithdraw();
  return;
}

showMenu();
