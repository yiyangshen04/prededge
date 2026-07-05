/**
 * 手动 SMTP 测试 — 发一封固定内容测试邮件并打印 messageId。
 *
 * 用法: npm run mail:test   (等价于 npx tsx scripts/send-test-mail.ts)
 * 需要 .env.local / 环境变量里配置 MAIL_USER / MAIL_AUTH_CODE(见 .env.example)。
 */
import { sendMail } from "./mailer";

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const { messageId } = await sendMail({
    subject: `[PredEdge] SMTP 测试邮件 — ${now}`,
    text:
      `这是一封 PredEdge 扫描器的 SMTP 测试邮件。\n` +
      `发送时间: ${now}\n` +
      `收到它说明 SMTP_HOST / MAIL_USER / MAIL_AUTH_CODE 配置正确。`,
    html: `<div style="background:#14171c;color:#e6e8eb;padding:20px 22px;border-radius:10px;font-family:-apple-system,'Segoe UI',Roboto,Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:600px">
  <h2 style="margin:0 0 8px;font-size:16px;color:#f3f4f6">PredEdge SMTP 测试</h2>
  <p style="margin:0 0 6px;font-size:13px">发送时间: ${now}</p>
  <p style="margin:0;font-size:13px;color:#9aa3ad">收到这封邮件,说明 SMTP 配置正确,scan-notify 可以正常发通知。</p>
</div>`,
  });
  console.log(`[mail:test] 发送成功 messageId=${messageId}`);
}

main().catch((err) => {
  console.error("[mail:test] 发送失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
