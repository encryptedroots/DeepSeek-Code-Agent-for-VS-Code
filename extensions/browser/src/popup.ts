const DEFAULT_BRIDGE_URL = "http://127.0.0.1:43127";
const bridgeUrlInput = document.querySelector<HTMLInputElement>("#bridge-url")!;
const pairingInput = document.querySelector<HTMLInputElement>("#pairing")!;
const statusPanel = document.querySelector<HTMLDivElement>("#status")!;
const statusText = document.querySelector<HTMLSpanElement>("#status-text")!;

function showStatus(message: string, state: "info" | "success" | "error" = "info"): void {
  statusPanel.hidden = false;
  statusPanel.dataset.state = state;
  statusText.textContent = message;
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

void chrome.storage.local
  .get("baseUrl")
  .then((stored) => {
    bridgeUrlInput.value = typeof stored.baseUrl === "string" ? stored.baseUrl : DEFAULT_BRIDGE_URL;
  })
  .catch((error: unknown) => {
    showStatus(
      error instanceof Error ? error.message : "Could not load settings. Check extension storage permissions.",
      "error",
    );
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
  showStatus("Checking VS Code pairing and configured conversation…", "info");
  try {
    const result = await sendBridgeMessage({ type: "health" });
    showStatus(
      String(result.message ?? "Could not check bridge status."),
      result.pageAvailable === true && result.conversationMatched === true ? "success" : result.ok ? "info" : "error",
    );
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Could not check the configured conversation.", "error");
  }
});
