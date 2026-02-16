/**
 * Comprehensive mock for the `vscode` module used in unit tests.
 * Provides stubs for all VSCode APIs that DevCrew depends on.
 */

// ─── Uri ──────────────────────────────────────────────────────────────────────

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly fsPath: string;

  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.authority = '';
    this.path = path;
    this.fsPath = path;
  }

  static file(path: string): Uri {
    return new Uri('file', path);
  }

  static parse(value: string): Uri {
    return new Uri('file', value);
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.path, ...pathSegments].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
  }
}

// ─── Position & Range ─────────────────────────────────────────────────────────

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position
  ) {}
}

// ─── EventEmitter ─────────────────────────────────────────────────────────────

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    });
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

// ─── Disposable ───────────────────────────────────────────────────────────────

export class Disposable {
  constructor(private callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

// ─── CancellationTokenSource ──────────────────────────────────────────────────

export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: () => new Disposable(() => {}),
  };

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  dispose(): void {}
}

// ─── ThemeIcon / ThemeColor ───────────────────────────────────────────────────

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

// ─── WorkspaceEdit ────────────────────────────────────────────────────────────

export class WorkspaceEdit {
  private _edits: Array<{ type: string; uri: Uri; args: unknown[] }> = [];

  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this._edits.push({ type: 'createFile', uri, args: [options] });
  }

  deleteFile(uri: Uri): void {
    this._edits.push({ type: 'deleteFile', uri, args: [] });
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this._edits.push({ type: 'insert', uri, args: [position, newText] });
  }

  replace(uri: Uri, range: Range, newText: string): void {
    this._edits.push({ type: 'replace', uri, args: [range, newText] });
  }

  delete(uri: Uri, range: Range): void {
    this._edits.push({ type: 'delete', uri, args: [range] });
  }

  get edits() {
    return this._edits;
  }
}

// ─── RelativePattern ──────────────────────────────────────────────────────────

export class RelativePattern {
  constructor(
    readonly base: Uri | string,
    readonly pattern: string
  ) {}
}

// ─── TreeItem ─────────────────────────────────────────────────────────────────

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string | MarkdownString;
  iconPath?: ThemeIcon;
  contextValue?: string;
  collapsibleState?: TreeItemCollapsibleState;
  command?: unknown;

  constructor(
    label: string,
    collapsibleState?: TreeItemCollapsibleState
  ) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

// ─── MarkdownString ───────────────────────────────────────────────────────────

export class MarkdownString {
  constructor(readonly value: string) {}
}

// ─── ProgressLocation ─────────────────────────────────────────────────────────

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

// ─── StatusBarAlignment ───────────────────────────────────────────────────────

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// ─── ViewColumn ───────────────────────────────────────────────────────────────

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

// ─── LanguageModelChatMessage ─────────────────────────────────────────────────

export class LanguageModelChatMessage {
  constructor(
    readonly role: number,
    readonly content: string
  ) {}

  static User(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(1, content);
  }

  static Assistant(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(2, content);
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────

export const window = {
  createOutputChannel: (name: string) => ({
    appendLine: (_msg: string) => {},
    show: () => {},
    dispose: () => {},
    name,
  }),
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => ({
    text: '',
    tooltip: '',
    command: '',
    backgroundColor: undefined as ThemeColor | undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createWebviewPanel: (
    _viewType: string,
    _title: string,
    _showOptions: ViewColumn,
    _options?: object
  ) => ({
    webview: {
      html: '',
      onDidReceiveMessage: () => new Disposable(() => {}),
    },
    reveal: () => {},
    onDidDispose: () => new Disposable(() => {}),
    dispose: () => {},
  }),
  registerTreeDataProvider: (_viewId: string, _provider: unknown) =>
    new Disposable(() => {}),
  showInformationMessage: async (..._args: unknown[]) => undefined as string | undefined,
  showWarningMessage: async (..._args: unknown[]) => undefined as string | undefined,
  showErrorMessage: async (..._args: unknown[]) => undefined as string | undefined,
  showInputBox: async (_options?: object) => undefined as string | undefined,
  withProgress: async (
    _options: object,
    task: (
      progress: { report: (value: { message?: string }) => void },
      token: { onCancellationRequested: () => Disposable; isCancellationRequested: boolean }
    ) => Promise<unknown>
  ) => {
    return task(
      { report: () => {} },
      { onCancellationRequested: () => new Disposable(() => {}), isCancellationRequested: false }
    );
  },
};

// ─── Workspace ────────────────────────────────────────────────────────────────

export const workspace = {
  workspaceFolders: [
    {
      uri: Uri.file('/workspace'),
      name: 'workspace',
      index: 0,
    },
  ] as Array<{ uri: Uri; name: string; index: number }> | undefined,

  textDocuments: [] as Array<{
    uri: Uri;
    getText: () => string;
    isDirty: boolean;
    save: () => Promise<boolean>;
    positionAt: (offset: number) => Position;
  }>,

  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => defaultValue,
  }),

  applyEdit: async (_edit: WorkspaceEdit) => true,

  fs: {
    readFile: async (_uri: Uri) => Buffer.from('mock file content', 'utf-8'),
    writeFile: async (_uri: Uri, _content: Uint8Array) => {},
    stat: async (_uri: Uri) => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
  },

  findFiles: async (_include: RelativePattern, _exclude?: string) =>
    [] as Uri[],

  asRelativePath: (pathOrUri: Uri | string) => {
    const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.path;
    return p.replace('/workspace/', '');
  },

  openTextDocument: async (_uri: Uri) => ({
    uri: _uri,
    getText: () => 'mock file content',
    positionAt: (offset: number) => new Position(0, offset),
  }),
};

// ─── Commands ─────────────────────────────────────────────────────────────────

export const commands = {
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
    return new Disposable(() => {});
  },
  executeCommand: async (_command: string, ..._args: unknown[]) => {},
};

// ─── Language Model API ───────────────────────────────────────────────────────

export const lm = {
  selectChatModels: async (_selector?: { vendor?: string }) => {
    return [
      {
        name: 'test-model',
        vendor: 'copilot',
        family: 'gpt-4',
        version: '1',
        maxInputTokens: 128000,
        sendRequest: async (
          _messages: LanguageModelChatMessage[],
          _options: object,
          _token: unknown
        ) => ({
          text: (async function* () {
            yield 'mock response';
          })(),
        }),
      },
    ];
  },
};
