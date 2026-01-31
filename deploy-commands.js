const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  throw new Error("ENV 필요: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID");
}

// 지점 목록은 ENV로 받을 수도 있는데, 1차는 고정으로 넣음.
// 늘어나면 여기 addChoices만 추가하거나(단순), 2차에서 시트에서 자동 로딩 가능.
const cmd = new SlashCommandBuilder()
  .setName("매출보고")
  .setDescription("지점 선택 + 사진3장 보고 (시트 업서트 + 버튼 확정)")
  .addStringOption(opt =>
    opt.setName("branch").setDescription("지점").setRequired(true)
      .addChoices(
        { name: "강남", value: "강남" },
        { name: "홍대", value: "홍대" },
        { name: "잠실", value: "잠실" },
        { name: "대전봉명", value: "대전봉명" },
        { name: "부산서면", value: "부산서면" }
      )
  )
  .addStringOption(opt =>
    opt.setName("biz_date").setDescription("영업일자 (YYYY-MM-DD, 미입력 시 오늘)").setRequired(false)
  )
  .addAttachmentOption(opt => opt.setName("photo1").setDescription("사진 1").setRequired(true))
  .addAttachmentOption(opt => opt.setName("photo2").setDescription("사진 2").setRequired(true))
  .addAttachmentOption(opt => opt.setName("photo3").setDescription("사진 3").setRequired(true))
  .addStringOption(opt =>
    opt.setName("memo").setDescription("메모(선택)").setRequired(false)
  );

(async () => {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: [cmd.toJSON()] }
  );
  console.log("✅ 슬래시 커맨드 등록 완료 (/매출보고)");
})();
