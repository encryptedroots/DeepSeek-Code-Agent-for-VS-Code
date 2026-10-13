import { DEFAULT_CHAT_URL, persistDeepSeekChatUrl, validateDeepSeekChatUrl } from "./chatUrl";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:43127";
const bridgeUrlInput = document.querySelector<HTMLInputElement>("#bridge-url")!;
const chatUrlInput = document.querySelector<HTMLInputElement>("#chat-url")!;
const pairingInput = document.querySelector<HTMLInputElement>("#pairing")!;
const chatUrlForm = document.querySelector<HTMLFormElement>("#chat-url-form")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save-chat-url")!;
const saveState = document.querySelector<HTMLDivElement>("#save-state")!;
const statusPanel = document.querySelector<HTMLDivElement>("#status")!;
const statusText = document.querySelector<HTMLSpanElement>("#status-text")!;

function showStatus(message: string, state: "info" | "success" | "error" = "info"): void {
  statusPanel.hidden = false;
  statusPanel.dataset.state = state;
  statusText.textContent = message;
}

function showSaveState(message: string, state: "saved" | "unsaved" | "error"): void {
  saveState.textContent = message;
  saveState.dataset.state = state;
  chatUrlInput.setAttribute("aria-invalid", state === "error" ? "true" : "false");
}

function sendBridgeMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (typeof response !== "object" || response === null) {
        reject(new Error("The bridge did not return a response. Reload the extension and try again."));
        return;
      }
      resolve(response as Record<string, unknown>);
    });
  });
}

async function readStoredChatUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("chatUrl");
  if (typeof stored.chatUrl !== "string") return DEFAULT_CHAT_URL;
  return validateDeepSeekChatUrl(stored.chatUrl);
}

void chrome.storage.local
  .get(["baseUrl", "chatUrl"])
  .then((stored) => {
    bridgeUrlInput.value = typeof stored.baseUrl === "string" ? stored.baseUrl : DEFAULT_BRIDGE_URL;
    if (typeof stored.chatUrl !== "string") {
      chatUrlInput.value = DEFAULT_CHAT_URL;
      showSaveState("Example URL — save to keep this conversation.", "unsaved");
      return;
    }
    try {
      chatUrlInput.value = validateDeepSeekChatUrl(stored.chatUrl);
      showSaveState("Saved in this browser.", "saved");
    } catch (error) {
      chatUrlInput.value = stored.chatUrl;
      showSaveState(error instanceof Error ? error.message : "The saved URL is invalid. Replace it and save.", "error");
    }
  })
  .catch((error: unknown) => {
    showStatus(
      error instanceof Error ? error.message : "Could not load settings. Check extension storage permissions.",
      "error",
    );
  });

chatUrlInput.addEventListener("input", () => {
  showSaveState("Unsaved changes — save this URL before using it.", "unsaved");
});

chatUrlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!chatUrlForm.reportValidity()) return;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  showSaveState("Validating and saving…", "unsaved");
  try {
    const savedUrl = await persistDeepSeekChatUrl(chatUrlInput.value, chrome.storage.local);
    chatUrlInput.value = savedUrl;
    showSaveState("Saved and verified in this browser.", "saved");
    showStatus("Conversation link saved. The matching chat and input are checked before each task.", "success");
  } catch (error) {
    showSaveState(
      error instanceof Error ? error.message : "Could not save the URL. Check browser extension storage and try again.",
      "error",
    );
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save";
  }
});

document.querySelector<HTMLButtonElement>("#pair")!.addEventListener("click", async () => {
  showStatus("Connecting to the local VS Code bridge…", "info");
  try {
    const result = await sendBridgeMessage({
      type: "pair",
      baseUrl: bridgeUrlInput.value.trim(),
      code: pairingInput.value.trim(),
    });
    showStatus(String(result.message ?? "Could not pair with VS Code."), result.ok ? "success" : "error");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Pairing failed. Check the bridge address and code.", "error");
  }
});

document.querySelector<HTMLButtonElement>("#health")!.addEventListener("click", async () => {
  try {
    const saved = await readStoredChatUrl();
    const entered = validateDeepSeekChatUrl(chatUrlInput.value);
    if (saved !== entered) throw new Error("Save the edited conversation URL before checking status.");
    showStatus("Checking VS Code pairing, browser, and conversation…", "info");
    const result = await sendBridgeMessage({ type: "health" });
    showStatus(
      String(result.message ?? "Could not check bridge status."),
      result.pageAvailable === true && result.conversationMatched === true ? "success" : result.ok ? "info" : "error",
    );
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Could not check the configured conversation.", "error");
  }
});
