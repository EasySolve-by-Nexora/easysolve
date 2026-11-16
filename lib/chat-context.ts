const CHAT_CONTEXT_BYTES = 90000;
export function boundedChatContext(data: {
  issues: any[];
  runs: any[];
  repos: any[];
  history: any[];
  selectedIdentity?: string;
}) {
  let { issues, history } = data;
  let text = JSON.stringify({ ...data, issues, history });
  // Drop the least relevant material first: older issues, then older messages.
  while (Buffer.byteLength(text) > CHAT_CONTEXT_BYTES && issues.length > 5) {
    issues = issues.slice(0, Math.ceil(issues.length / 2));
    text = JSON.stringify({ ...data, issues, history });
  }
  while (Buffer.byteLength(text) > CHAT_CONTEXT_BYTES && history.length > 2) {
    history = history.slice(Math.ceil(history.length / 2));
    text = JSON.stringify({ ...data, issues, history });
  }
  return text;
}
