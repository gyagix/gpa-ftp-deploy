import * as vscode from 'vscode';

export class Logger {
  private channel: vscode.OutputChannel;

  constructor(channelName: string) {
    this.channel = vscode.window.createOutputChannel(channelName);
  }

  info(msg: string): void {
    this._log('INFO', msg);
  }

  error(msg: string): void {
    this._log('ERROR', msg);
    // Gli errori appaiono sempre nel log anche senza showLog esplicito
    this.channel.show(true);
  }

  debug(msg: string): void {
    this._log('DEBUG', msg);
  }

  show(): void {
    this.channel.show();
  }

  private _log(level: string, msg: string): void {
    const ts = new Date().toLocaleTimeString('it-IT');
    this.channel.appendLine(`[${ts}] [${level}] ${msg}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
