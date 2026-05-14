interface SendMagicLinkConfig {
  brandName: string;
  brandUrl: string;
  authBaseUrl: string;
  resendFrom: string;
  resendApiKey: string;
}

export async function sendMagicLink(
  to: string,
  token: string,
  config: SendMagicLinkConfig,
  next?: string,
): Promise<void> {
  const link =
    `${config.authBaseUrl}/verify?token=${token}` +
    (next ? `&next=${encodeURIComponent(next)}` : '');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.resendFrom,
      to,
      subject: `Sign in to ${config.brandName}`,
      html: magicLinkHtml(link, config.brandName, config.brandUrl),
      text: `Sign in to ${config.brandName}: ${link}\n\nThis link expires in 10 minutes and can only be used once.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

function magicLinkHtml(link: string, brandName: string, brandUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#fcf5e5;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fcf5e5;">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fcf5e5;border:1px solid #915f6d;">
        <tr><td style="padding:32px 40px;border-bottom:1px solid #915f6d;">
          <p style="margin:0;font-size:22px;color:#301934;letter-spacing:0.05em;">${escapeHtml(brandName)}</p>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#301934;">
            Follow this link to sign in. The link expires in 10&nbsp;minutes and can only be used once.
          </p>
          <table cellpadding="0" cellspacing="0"><tr><td>
            <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 28px;background:#301934;color:#fcf5e5;font-family:Georgia,serif;font-size:15px;text-decoration:none;letter-spacing:0.04em;">Sign in</a>
          </td></tr></table>
          <p style="margin:32px 0 0;font-size:13px;color:#51414f;line-height:1.5;">
            If the button above does not work, copy and paste this URL into your browser:<br>
            <span style="color:#722f37;word-break:break-all;">${escapeHtml(link)}</span>
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #915f6d;">
          <p style="margin:0;font-size:12px;color:#51414f;line-height:1.5;">
            If you did not request this link, you can ignore this email.<br>
            <a href="${escapeHtml(brandUrl)}" style="color:#915f6d;">${escapeHtml(brandUrl)}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
