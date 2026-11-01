/**
 * The words of the one-time-code messages. Fixed text plus digits: nothing a visitor typed is ever put in a message, so a
 * message can not be used to send somebody else's words (a phishing line, a link) from Terucon's address or number.
 */
const WHY = {
  login: 'to sign in to Terucon',
  'verify-contact': 'to confirm this contact detail on your Terucon account',
  delete: 'to delete your Terucon account',
};

export const DEFAULT_SMS_TEMPLATE = '{code} is your Terucon verification code. It works for {minutes} minutes. Do not share it with anyone.';

export function emailMessage({ code, ttlMinutes, purpose }) {
  return {
    subject: `Terucon: your code is ${code}`,
    text:
      `Your Terucon code is ${code}\r\n\r\n` +
      `Use it ${WHY[purpose] ?? WHY.login}. It works for ${ttlMinutes} minutes and only once.\r\n\r\n` +
      'Never tell this code to anyone. Terucon will never ask you for it, by phone, message or e-mail.\r\n\r\n' +
      'If you did not ask for it, you can ignore this message: nothing happens unless the code is used.\r\n',
  };
}

export function smsMessage({ code, ttlMinutes, template = DEFAULT_SMS_TEMPLATE }) {
  return template.replaceAll('{code}', code).replaceAll('{minutes}', String(ttlMinutes));
}

/** A template for text messages must carry the code, and stay one short plain line (some countries require a pre-approved text). */
export function validSmsTemplate(template) {
  return typeof template === 'string' && template.includes('{code}') && template.length <= 300 && /^[\x20-\x7eऀ-ॿ]+$/.test(template);
}
