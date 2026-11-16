const messages: Record<string, string> = {
  SETUP_WEB_SEARCH_UNSUPPORTED: 'Web search requires an official OpenAI connection. Select a compatible connection and save again.',
  SETUP_PENDING_RUNS: 'Finish running tasks and pending reviews before changing the assistant. Your conversations are preserved.',
  SETUP_DRAFT_PENDING: 'Save or discard the configuration draft before changing this assistant.',

  SETUP_PROVIDER_AUTH: 'The provider rejected this API key. Enter a valid key for the selected provider and try again.',
  SETUP_PROVIDER_QUOTA: 'The provider has reached a usage or rate limit. Check your account’s quota or wait before trying again.',
  SETUP_PROVIDER_MODEL: 'This model is unavailable for this connection. Check the model ID, account access and API format, then enter your key again.',
  SETUP_PROVIDER_UNREACHABLE: 'Could not reach the provider. Check your connection and API URL, then enter your key again and retry.',
  SETUP_PROVIDER_RESPONSE: 'The provider did not return a usable response. Check the model and API format, then enter your key again.',
  COORDINATOR_VERSION_UNSUPPORTED: 'This app and the running service use incompatible versions. Update both, then retry startup. Your saved conversations remain available.',
  COORDINATOR_CAPABILITY_UNSUPPORTED: 'This app and the running service use incompatible versions. Update both, then retry startup. Your saved conversations remain available.',
  SETUP_KEYCHAIN_WRITE_UNCONFIRMED: 'Your changes may have been saved. Retry startup to reload the saved state before editing again.',
  SETUP_KEYCHAIN_BUSY: 'The system keychain is still responding. Wait before retrying.',
  SETUP_KEYCHAIN_UNAVAILABLE: 'The system keychain could not be read. Check the macOS keychain request, then retry startup.',
};
export function setupErrorMessage(error: string): string {
  for (const [code, message] of Object.entries(messages)) if (error.includes(code)) return message;
  return error;
}
