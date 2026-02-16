import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VSCodeLLMService } from '../config/llmProviders';
import * as vscode from 'vscode';

describe('VSCodeLLMService', () => {
  let service: VSCodeLLMService;

  beforeEach(() => {
    service = new VSCodeLLMService();
  });

  it('modelName is "pending..." before initialization', () => {
    expect(service.modelName).toBe('pending...');
  });

  it('initialize selects a model and updates modelName', async () => {
    await service.initialize();
    expect(service.modelName).toContain('test-model');
  });

  it('sendMessages returns accumulated text from stream', async () => {
    await service.initialize();
    const result = await service.sendMessages([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result).toBe('mock response');
  });

  it('sendMessages auto-initializes if not initialized', async () => {
    // Don't call initialize() first
    const result = await service.sendMessages([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result).toBe('mock response');
    expect(service.modelName).toContain('test-model');
  });

  it('streamMessages returns an async iterable', async () => {
    await service.initialize();
    const stream = await service.streamMessages([
      { role: 'user', content: 'Hello' },
    ]);

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('mock response');
  });

  it('throws when no models are available', async () => {
    const origSelectChatModels = vscode.lm.selectChatModels;
    (vscode.lm as any).selectChatModels = vi.fn().mockResolvedValue([]);

    await expect(service.initialize()).rejects.toThrow(/No language models/);

    (vscode.lm as any).selectChatModels = origSelectChatModels;
  });

  it('falls back to non-copilot models if copilot unavailable', async () => {
    const fallbackModel = {
      name: 'fallback-model',
      vendor: 'other',
      family: 'custom',
      version: '1',
      maxInputTokens: 4096,
      sendRequest: vi.fn().mockResolvedValue({
        text: (async function* () {
          yield 'fallback response';
        })(),
      }),
    };

    const origSelectChatModels = vscode.lm.selectChatModels;
    (vscode.lm as any).selectChatModels = vi.fn().mockImplementation(
      (selector?: { vendor?: string }) => {
        if (selector?.vendor === 'copilot') return Promise.resolve([]);
        return Promise.resolve([fallbackModel]);
      }
    );

    await service.initialize();
    expect(service.modelName).toContain('fallback-model');

    const result = await service.sendMessages([
      { role: 'user', content: 'test' },
    ]);
    expect(result).toBe('fallback response');

    (vscode.lm as any).selectChatModels = origSelectChatModels;
  });

  it('converts system messages to user messages with prefix', async () => {
    let capturedMessages: any[] = [];
    const model = {
      name: 'spy-model',
      vendor: 'copilot',
      family: 'test',
      version: '1',
      maxInputTokens: 128000,
      sendRequest: vi.fn().mockImplementation((messages: any[]) => {
        capturedMessages = messages;
        return Promise.resolve({
          text: (async function* () {
            yield 'ok';
          })(),
        });
      }),
    };

    const origSelectChatModels = vscode.lm.selectChatModels;
    (vscode.lm as any).selectChatModels = vi.fn().mockResolvedValue([model]);

    const svc = new VSCodeLLMService();
    await svc.initialize();
    await svc.sendMessages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ]);

    expect(capturedMessages).toHaveLength(2);
    // System message should be converted to User with prefix
    expect(capturedMessages[0].content).toContain('[SYSTEM INSTRUCTIONS]');
    expect(capturedMessages[0].content).toContain('You are a helpful assistant.');

    (vscode.lm as any).selectChatModels = origSelectChatModels;
  });
});
