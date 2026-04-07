import * as vscode from 'vscode';

/**
 * Chiave usata nel Secret Storage per ogni profilo.
 * Format: ftp-deploy::<profileName>
 */
function secretKey(profileName: string): string {
  return `ftp-deploy::${profileName}`;
}

/**
 * Salva la password nel keychain OS tramite VS Code Secret Storage.
 * La password NON viene mai scritta in settings.json.
 */
export async function savePassword(
  context: vscode.ExtensionContext,
  profileName: string,
  password: string
): Promise<void> {
  await context.secrets.store(secretKey(profileName), password);
}

/**
 * Legge la password dal keychain.
 * Restituisce undefined se non ancora salvata.
 */
export async function loadPassword(
  context: vscode.ExtensionContext,
  profileName: string
): Promise<string | undefined> {
  return context.secrets.get(secretKey(profileName));
}

/**
 * Elimina la password dal keychain.
 */
export async function deletePassword(
  context: vscode.ExtensionContext,
  profileName: string
): Promise<void> {
  await context.secrets.delete(secretKey(profileName));
}

/**
 * Chiede la password all'utente via input box e la salva nel keychain.
 * Restituisce la password inserita, o undefined se l'utente ha annullato.
 */
export async function promptAndSavePassword(
  context: vscode.ExtensionContext,
  profileName: string,
  host: string
): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    title: `FTP Deploy — Password per profilo "${profileName}"`,
    prompt: `Inserisci la password per ${host} (verrà salvata nel keychain di sistema)`,
    password: true,
    ignoreFocusOut: true,
  });

  if (password === undefined) return undefined; // utente ha premuto Esc

  await savePassword(context, profileName, password);
  return password;
}

/**
 * Risolve la password per un profilo:
 * 1. Cerca nel keychain
 * 2. Se non trovata, chiede all'utente e la salva
 * 3. Se ftpDeploy.password è settata in settings, la usa SOLO come fallback
 *    (e avvisa l'utente di migrarla)
 *
 * Restituisce null se non è stato possibile ottenere la password.
 */
export async function resolvePassword(
  context: vscode.ExtensionContext,
  profileName: string,
  host: string,
  passwordInSettings: string
): Promise<string | null> {
  // Prima cerca nel keychain
  const stored = await loadPassword(context, profileName);
  if (stored) return stored;

  // Fallback: password in chiaro nel settings (deprecato)
  if (passwordInSettings) {
    vscode.window.showWarningMessage(
      `FTP Deploy: la password del profilo "${profileName}" è in chiaro nel settings.json. ` +
      `Usa il comando "FTP Deploy: Salva password nel keychain" per migrare.`,
      'Migra ora'
    ).then(async (choice) => {
      if (choice === 'Migra ora') {
        await savePassword(context, profileName, passwordInSettings);
        vscode.window.showInformationMessage(
          `Password del profilo "${profileName}" spostata nel keychain. ` +
          `Puoi rimuovere "ftpDeploy.password" dal settings.json.`
        );
      }
    });
    return passwordInSettings;
  }

  // Niente in keychain né in settings: chiedi all'utente
  return await promptAndSavePassword(context, profileName, host) ?? null;
}
