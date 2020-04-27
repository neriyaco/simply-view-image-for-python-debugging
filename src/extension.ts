// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { join } from 'path';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

const WORKING_DIR = 'svifpod';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "simply-view-image-for-python-opencv-debugging" is now active!');

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider('python', 
		new PythonOpencvImageProvider(), {	providedCodeActionKinds: [vscode.CodeActionKind.Empty] }));


	context.subscriptions.push(
		vscode.debug.onDidReceiveDebugSessionCustomEvent( e => {
			console.log(e.event);
		})
	);

}

// this method is called when your extension is deactivated
export function deactivate() {}


/**
 * Provides code actions for python opencv image.
 */
export class PythonOpencvImageProvider implements vscode.CodeActionProvider {

	private workingdir :string;
	
	public constructor()
	{
		let dir = tmpdir();
		dir = join(dir, WORKING_DIR);
		if (existsSync(dir))
		{
			let files = readdirSync(dir);
			files.forEach(file => {
				let curPath = join(dir, file);
				unlinkSync(curPath);
			});
		}
		else
		{
			mkdirSync(dir);
		}

		this.workingdir = dir;
	}

	public async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.Command[] | undefined> {
		const session = vscode.debug.activeDebugSession;
		if (session === undefined) {
			return;
		}

		let res = await session.customRequest('threads', {});
		let threads = res.threads;
		let mainThread = threads[0].id;

		res = await session.customRequest('stackTrace', { threadId: mainThread });
		let stacks = res.stackFrames;
		let callStack = stacks[0].id;

		res = await session.customRequest('scopes', {frameId: callStack});
		let scopes = res.scopes;
		let local = scopes[0];

		res = await session.customRequest('variables', { variablesReference: local.variablesReference });
		let variables: any[] = res.variables;

		const selectedVariable = document.getText(document.getWordRangeAtPosition(range.start));

		let targetVariable = variables.find( v => v.name === selectedVariable);
		if (targetVariable === undefined)
		{
			return;
		}

		let path = join(this.workingdir,  `${targetVariable.name}.png`);
		let savepath = path.replace(/\\/g, '/');

		const vn = targetVariable.evaluateName; // var name
		const float_expression =  `${vn} * 255.0 if (${vn}.dtype == np.float64 or ${vn}.dtype == np.float32) else ${vn}`;
		const expression = `cv2.imwrite('${savepath}', ${float_expression})`;
		res = await session.customRequest("evaluate", { expression: expression, frameId: callStack, context:'hover' });
		console.log(`evaluate ${expression} result: ${res.result}`);

		return [
			{ command:"vscode.open", title: 'View Image', arguments: [ vscode.Uri.file(path), vscode.ViewColumn.Beside ] }
		];
	}
}