import * as vscode from 'vscode';
import { LLMMessage, LLMService } from '../types';

/**
 * LLM service that uses VSCode's built-in Language Model API (vscode.lm).
 * This leverages models provided by any installed LM provider (e.g. GitHub Copilot Chat).
 */
export class VSCodeLLMService implements LLMService {
  private model: vscode.LanguageModelChat | null = null;
  private _modelName = 'pending...';

  get modelName(): string {
    return this._modelName;
  }

  /**
   * Initialize by selecting the best available chat model.
   * Prefers the default Copilot model.
   */
  async initialize(): Promise<void> {
    // Select available chat models
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
    });

    if (models.length === 0) {
      // Fall back to any available model
      const allModels = await vscode.lm.selectChatModels();
      if (allModels.length === 0) {
        throw new Error(
          'No language models available. Make sure a language model provider (e.g. GitHub Copilot Chat) is available and signed in.'
        );
      }
      this.model = allModels[0];
    } else {
      // Use the first (default) Copilot model
      this.model = models[0];
    }

    this._modelName = `${this.model.name} (${this.model.vendor})`;
  }

  async sendMessages(
    messages: LLMMessage[],
    token?: vscode.CancellationToken
  ): Promise<string> {
    if (!this.model) {
      await this.initialize();
    }

    const vsMessages = this.convertMessages(messages);
    const cancellation = token ?? new vscode.CancellationTokenSource().token;

    const response = await this.model!.sendRequest(vsMessages, {}, cancellation);

    // Collect the full streamed response
    let result = '';
    for await (const chunk of response.text) {
      result += chunk;
    }

    return result;
  }

  async streamMessages(
    messages: LLMMessage[],
    token?: vscode.CancellationToken
  ): Promise<AsyncIterable<string>> {
    if (!this.model) {
      await this.initialize();
    }

    const vsMessages = this.convertMessages(messages);
    const cancellation = token ?? new vscode.CancellationTokenSource().token;

    const response = await this.model!.sendRequest(vsMessages, {}, cancellation);

    return response.text;
  }

  async streamWithProgress(
    messages: LLMMessage[],
    onChunk: (chunk: string, accumulated: string) => void,
    token?: vscode.CancellationToken
  ): Promise<string> {
    if (!this.model) {
      await this.initialize();
    }

    const vsMessages = this.convertMessages(messages);
    const cancellation = token ?? new vscode.CancellationTokenSource().token;

    const response = await this.model!.sendRequest(vsMessages, {}, cancellation);

    let accumulated = '';
    for await (const chunk of response.text) {
      accumulated += chunk;
      onChunk(chunk, accumulated);
    }

    return accumulated;
  }

  /**
   * Convert our internal message format to vscode.LanguageModelChatMessage.
   */
  private convertMessages(
    messages: LLMMessage[]
  ): vscode.LanguageModelChatMessage[] {
    return messages.map((msg) => {
      switch (msg.role) {
        case 'system':
          // VSCode LM API uses User messages for system prompts with a
          // specific preamble, or we can use the dedicated type if available
          return vscode.LanguageModelChatMessage.User(
            `[SYSTEM INSTRUCTIONS]\n${msg.content}`
          );
        case 'user':
          return vscode.LanguageModelChatMessage.User(msg.content);
        case 'assistant':
          return vscode.LanguageModelChatMessage.Assistant(msg.content);
      }
    });
  }
}
