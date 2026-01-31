const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  InteractionType
} = require("discord.js");

const { DateTime } = require("luxon");
const {
  getAuthClientFromEnv,
  upsertByBizDateBranch,
  updateStatusAndAmounts
} = require("./google/sheets");

// ===== ENV =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const RAW_SHEET_NAME = process.env.RAW_SHEET_NAME || "일매출_RAW";
const FINANCE_ROLE_ID = process.env.FINANCE_ROLE_ID; // 재무 역할 ID (필수)
const TZ = "Asia/Seoul";

if (!DISCORD_TOKEN) throw new Error("ENV DISCORD_TOKEN 필요");
if (!SHEET_ID) throw new Error("ENV SHEET_ID 필요");
if (!FINANCE_ROLE_ID) throw new Error("ENV FINANCE_ROLE_ID 필요");

// ===== Google Auth =====
const auth = getAuthClientFromEnv();

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function todayISO() {
  return DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
}

function validateBizDate(str) {
  // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function won(n) {
  const x = Number(n || 0);
  return x.toLocaleString("ko-KR");
}

function financeOnly(interaction) {
  const member = interaction.member;
  if (!member || !member.roles) return false;
  return member.roles.cache.has(FINANCE_ROLE_ID);
}

function buildButtons(reportId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rev:ok:${reportId}`).setLabel("확정(OK)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rev:review:${reportId}`).setLabel("검수필요").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rev:reshoot:${reportId}`).setLabel("재촬영").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rev:edit:${reportId}`).setLabel("수정").setStyle(ButtonStyle.Primary)
  );
}

function buildEmbed({ branch, bizDate, reporterTag, photo1, photo2, photo3, status, memo, salesTotal, closingCash, delta }) {
  const e = new EmbedBuilder()
    .setTitle("매출 보고 접수")
    .addFields(
      { name: "지점", value: branch, inline: true },
      { name: "영업일자", value: bizDate, inline: true },
      { name: "상태", value: status, inline: true },
      { name: "보고자", value: reporterTag, inline: false },
      { name: "실매출액", value: `₩ ${won(salesTotal)}`, inline: true },
      { name: "마감시재", value: `₩ ${won(closingCash)}`, inline: true },
      { name: "오차", value: `₩ ${won(delta)}`, inline: true }
    );

  if (memo) e.addFields({ name: "메모", value: memo, inline: false });

  e.addFields(
    { name: "사진1", value: photo1 || "-", inline: false },
    { name: "사진2", value: photo2 || "-", inline: false },
    { name: "사진3", value: photo3 || "-", inline: false }
  );

  e.setFooter({ text: "재무 담당자가 버튼으로 확정/검수/재촬영/수정 처리" });
  return e;
}

async function upsertPendingFromCommand(interaction) {
  const branch = interaction.options.getString("branch", true);
  const bizDateInput = interaction.options.getString("biz_date", false);
  const bizDate = bizDateInput ? bizDateInput : todayISO();
  if (!validateBizDate(bizDate)) {
    await interaction.reply({ content: "biz_date 형식이 올바르지 않습니다. 예: 2026-01-31", ephemeral: true });
    return;
  }

  const photo1 = interaction.options.getAttachment("photo1", true)?.url;
  const photo2 = interaction.options.getAttachment("photo2", true)?.url;
  const photo3 = interaction.options.getAttachment("photo3", true)?.url;
  const memo = interaction.options.getString("memo", false) || "";

  const reporterTag = `${interaction.user.username}#${interaction.user.discriminator}`;
  const reportId = String(interaction.id); // 고유 ID

  // 1차 MVP: OCR 전이므로 금액은 0으로 접수
  const salesTotal = 0;
  const cardSales = 0;
  const cashSales = 0;
  const otherSales = 0;
  const closingCash = 0;
  const delta = 0;

  const confirmedAt = ""; // 확정 시에 넣는다
  const status = "PENDING";

  // A~O row 구성
  const row = [
    bizDate,        // A 영업일자
    branch,         // B 지점
    salesTotal,     // C 실매출액
    cardSales,      // D 카드
    cashSales,      // E 현금
    otherSales,     // F 기타
    closingCash,    // G 마감시재
    delta,          // H 오차
    photo1,         // I
    photo2,         // J
    photo3,         // K
    reporterTag,    // L 보고자
    confirmedAt,    // M 확정일시
    status,         // N 상태
    reportId        // O 리포트ID
  ];

  await upsertByBizDateBranch({
    sheetId: SHEET_ID,
    sheetName: RAW_SHEET_NAME,
    auth,
    bizDate,
    branch,
    rowAtoO: row
  });

  const embed = buildEmbed({
    branch, bizDate, reporterTag,
    photo1, photo2, photo3,
    status,
    memo,
    salesTotal, closingCash, delta
  });

  // 메시지를 채널에 남기고 버튼 제공
  await interaction.reply({
    embeds: [embed],
    components: [buildButtons(reportId)]
  });
}

async function handleStatusButton(interaction, mode) {
  if (!financeOnly(interaction)) {
    await interaction.reply({ content: "재무 권한이 없습니다.", ephemeral: true });
    return;
  }

  const [_, action, reportId] = interaction.customId.split(":"); // rev:ok:REPORTID
  // reportId로 행 찾는 대신, 업서트 키가 (영업일자, 지점)이므로
  // 여기서는 embed에서 지점/영업일자를 읽어온다(메시지에 이미 있음).
  const msg = interaction.message;
  const embed = msg.embeds?.[0];
  if (!embed) {
    await interaction.reply({ content: "원본 보고 Embed를 찾지 못했습니다.", ephemeral: true });
    return;
  }

  const fields = embed.fields || [];
  const branch = fields.find(f => f.name === "지점")?.value;
  const bizDate = fields.find(f => f.name === "영업일자")?.value;

  if (!branch || !bizDate) {
    await interaction.reply({ content: "지점/영업일자 값을 읽지 못했습니다.", ephemeral: true });
    return;
  }

  const confirmedAt = DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss");
  const status =
    mode === "ok" ? "OK" :
    mode === "review" ? "NEEDS_REVIEW" :
    mode === "reshoot" ? "RESHOOT" : "PENDING";

  await updateStatusAndAmounts({
    sheetId: SHEET_ID,
    sheetName: RAW_SHEET_NAME,
    auth,
    bizDate,
    branch,
    patch: { status, confirmedAt, reportId }
  });

  // Embed 상태 업데이트
  const newEmbed = EmbedBuilder.from(embed);
  // 상태 field 갱신
  const newFields = fields.map(f => {
    if (f.name === "상태") return { ...f, value: status };
    return f;
  });
  newEmbed.setFields(newFields);

  // RESHOOT이면 보고자에게 알림(메시지 내 보고자 field 기반)
  if (mode === "reshoot") {
    // 보고자 tag는 user#0000이므로 멘션으로 정확히 못 잡음.
    // 2차에서 reporter의 userId도 저장하는 방식으로 개선 가능.
    // 현재는 채널에 안내만 남김.
    await interaction.reply({ content: `🔴 재촬영 요청 처리 완료: ${branch} / ${bizDate}`, ephemeral: true });
  } else {
    await interaction.reply({ content: `✅ 상태 업데이트: ${status}`, ephemeral: true });
  }

  await msg.edit({ embeds: [newEmbed] });
}

async function handleEditButton(interaction) {
  if (!financeOnly(interaction)) {
    await interaction.reply({ content: "재무 권한이 없습니다.", ephemeral: true });
    return;
  }

  const msg = interaction.message;
  const embed = msg.embeds?.[0];
  if (!embed) {
    await interaction.reply({ content: "원본 보고 Embed를 찾지 못했습니다.", ephemeral: true });
    return;
  }
  const fields = embed.fields || [];
  const branch = fields.find(f => f.name === "지점")?.value;
  const bizDate = fields.find(f => f.name === "영업일자")?.value;

  if (!branch || !bizDate) {
    await interaction.reply({ content: "지점/영업일자 값을 읽지 못했습니다.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`rev:modal_edit:${branch}:${bizDate}`)
    .setTitle("금액 수정(숫자만 입력)");

  // 숫자만 입력하도록 안내 (검증은 서버에서)
  const salesInput = new TextInputBuilder()
    .setCustomId("salesTotal")
    .setLabel("실매출액 (예: 380000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const closingInput = new TextInputBuilder()
    .setCustomId("closingCash")
    .setLabel("마감시재 (예: 51000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const deltaInput = new TextInputBuilder()
    .setCustomId("delta")
    .setLabel("오차금액 (예: -600000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(salesInput),
    new ActionRowBuilder().addComponents(closingInput),
    new ActionRowBuilder().addComponents(deltaInput)
  );

  await interaction.showModal(modal);
}

function parseIntSafe(s) {
  // 콤마/원/공백 제거
  const cleaned = String(s).replace(/[,\s₩원]/g, "");
  if (!/^[-]?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

async function handleEditModalSubmit(interaction) {
  if (!financeOnly(interaction)) {
    await interaction.reply({ content: "재무 권한이 없습니다.", ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(":"); // rev:modal_edit:branch:bizDate
  const branch = parts[2];
  const bizDate = parts[3];

  const salesTotal = parseIntSafe(interaction.fields.getTextInputValue("salesTotal"));
  const closingCash = parseIntSafe(interaction.fields.getTextInputValue("closingCash"));
  const delta = parseIntSafe(interaction.fields.getTextInputValue("delta"));

  if (salesTotal === null || closingCash === null || delta === null) {
    await interaction.reply({ content: "숫자 형식이 올바르지 않습니다. 예: 380000 / -600000", ephemeral: true });
    return;
  }

  const confirmedAt = DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss");
  const status = "NEEDS_REVIEW"; // 수정 후엔 검수 상태로 두는 게 안전

  await updateStatusAndAmounts({
    sheetId: SHEET_ID,
    sheetName: RAW_SHEET_NAME,
    auth,
    bizDate,
    branch,
    patch: { salesTotal, closingCash, delta, status, confirmedAt }
  });

  await interaction.reply({
    content: `✏️ 수정 반영 완료: ${branch} / ${bizDate}\n- 실매출: ₩${won(salesTotal)}\n- 시재: ₩${won(closingCash)}\n- 오차: ₩${won(delta)}\n상태: ${status}`,
    ephemeral: true
  });

  // 메시지 Embed도 업데이트(가능하면)
  const msg = interaction.message; // 모달 submit에선 message가 없을 수 있음
}

client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // /매출보고
    if (interaction.isChatInputCommand() && interaction.commandName === "매출보고") {
      await upsertPendingFromCommand(interaction);
      return;
    }

    // 버튼
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith("rev:ok:")) return await handleStatusButton(interaction, "ok");
      if (id.startsWith("rev:review:")) return await handleStatusButton(interaction, "review");
      if (id.startsWith("rev:reshoot:")) return await handleStatusButton(interaction, "reshoot");
      if (id.startsWith("rev:edit:")) return await handleEditButton(interaction);
    }

    // 모달
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId.startsWith("rev:modal_edit:")) {
        return await handleEditModalSubmit(interaction);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      // 이미 응답된 경우
      return;
    }
    await interaction.reply({ content: `에러: ${err.message}`, ephemeral: true });
  }
});

client.login(DISCORD_TOKEN);
