/**
 * The few styles the admin's own don't cover: the mailer picker, status marks and report bars.
 * Printed by the plugin's screens only, so no other page carries them.
 */
export const STYLES = `
.mailer-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin:16px 0;padding:0;list-style:none}
.mailer-card{display:block;height:100%;box-sizing:border-box;padding:14px 16px;border:1px solid #c3c4c7;border-radius:4px;background:#fff;text-decoration:none;color:#1d2327}
.mailer-card:hover,.mailer-card:focus{border-color:#2271b1;box-shadow:0 0 0 1px #2271b1;color:#1d2327}
.mailer-card strong{display:block;font-size:14px;margin-bottom:4px}
.mailer-card span{color:#50575e;font-size:12px}
.mailer-mark{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;line-height:1.7;background:#f0f0f1;color:#50575e;white-space:nowrap}
.mailer-mark.ok{background:#edfaef;color:#00691a}
.mailer-mark.bad{background:#fcf0f1;color:#b32d2e}
.mailer-mark.warn{background:#fcf9e8;color:#8a6100}
.mailer-mark.role{background:#f0f6fc;color:#135e96}
.mailer-env{margin:2px 0}
.mailer-bars{width:100%;max-width:760px;border-collapse:collapse}
.mailer-bars td,.mailer-bars th{padding:4px 8px;text-align:left;font-weight:400}
.mailer-bars .num{text-align:right;font-variant-numeric:tabular-nums;width:1%;white-space:nowrap}
.mailer-bar{display:flex;height:14px;min-width:160px;background:#f0f0f1;border-radius:2px;overflow:hidden}
.mailer-bar i{display:block;height:100%;background:#2271b1}
.mailer-bar i.failed{background:#d63638}
.mailer-totals{display:flex;gap:28px;flex-wrap:wrap;margin:12px 0 20px}
.mailer-totals div{font-size:13px;color:#50575e}
.mailer-totals b{display:block;font-size:26px;line-height:1.2;color:#1d2327;font-weight:600}
.mailer-preview{width:100%;height:420px;border:1px solid #c3c4c7;background:#fff}
.mailer-pre{white-space:pre-wrap;word-break:break-word;background:#f6f7f7;border:1px solid #dcdcde;padding:12px;max-height:420px;overflow:auto;margin:0}
.mailer-details{width:100%;border-collapse:collapse}
.mailer-details th{width:140px;text-align:left;vertical-align:top;padding:5px 10px 5px 0;font-weight:600}
.mailer-details td{padding:5px 0;word-break:break-word}
.mailer-condition{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center}
.mailer-search{float:right;margin:0 0 8px}
.mailer-actions{margin:1em 0}
`
