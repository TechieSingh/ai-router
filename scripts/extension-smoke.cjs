const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const root = path.resolve(__dirname, '..');
  try {
    const extension = vscode.extensions.getExtension('local-dev.jev-code-router');
    if (!extension) throw new Error('Extension not registered');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['jevRouter.open', 'jevRouter.configure', 'jevRouter.diagnostics', 'jevRouter.memory']) if (!commands.includes(id)) throw new Error(`Command missing: ${id}`);
    await vscode.commands.executeCommand('jevRouter.open');
    await new Promise(resolve => setTimeout(resolve, 1500));
    await fs.writeFile(path.join(root, '.runtime', 'extension-smoke-result.json'), JSON.stringify({ success: true, vscode: vscode.version, active: extension.isActive, commands: commands.filter(c => c.startsWith('jevRouter.')) }, null, 2));
  } catch (error) {
    await fs.writeFile(path.join(root, '.runtime', 'extension-smoke-result.json'), JSON.stringify({ success: false, error: String(error), stack: error.stack }, null, 2));
    throw error;
  }
};
