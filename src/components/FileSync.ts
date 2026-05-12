import {App, Notice, TFile, MarkdownView, WorkspaceLeaf} from "obsidian";
import {exec} from "child_process";
import {getAbsolutePath, isNotebookPaired, runJupytext} from "../utils/helpers";
import {JupyMDPluginSettings} from "./types";
import * as fs from "fs";

type RebuildableWorkspaceLeaf = WorkspaceLeaf & {
	rebuildView?: () => void;
};

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class FileSync {
	private readonly pythonPath: string;
	private settings: JupyMDPluginSettings;

	private lastSyncTime: number = 0;
	private syncDebounceTimeout: number | null = null;
	private readonly SYNC_DEADTIME_MS = 1500;
	private readonly DEBOUNCE_DELAY_MS = 500;

	constructor(private app: App, pythonPath: string, settings: JupyMDPluginSettings) {
		this.pythonPath = pythonPath;
		this.settings = settings;
	}

	public isSyncBlocked(): boolean {
		const now = Date.now();
		const inDeadtime = now - this.lastSyncTime < this.SYNC_DEADTIME_MS;
		const inDebounce = this.syncDebounceTimeout !== null;
		return inDeadtime || inDebounce;
	}

	public async handleSync(file?: TFile, verbose?: boolean): Promise<void> {
		const targetFile = file ?? this.app.workspace.getActiveFile();
		if (!targetFile) return;

		if (this.isSyncBlocked()) {
			return;
		}

		if (this.syncDebounceTimeout) {
			activeWindow.clearTimeout(this.syncDebounceTimeout);
		}

		this.syncDebounceTimeout = activeWindow.setTimeout(() => {
			this.syncDebounceTimeout = null;

			if (!this.isSyncBlocked()) {
				void this.performSync(targetFile);
			}
		}, this.DEBOUNCE_DELAY_MS);

		if (verbose) {
			new Notice("Syncing...")
		}
	}

	private async performSync(file: TFile): Promise<void> {
		try {
			this.lastSyncTime = Date.now();
			await this.syncFiles(file);
		} catch (error) {
			console.error("Sync failed:", error);
			this.lastSyncTime = 0;
		}
	}

	async convertNotebookToNote() {
		const files = this.app.vault.getFiles().filter(f => f.path.endsWith('.ipynb'));
		if (files.length === 0) {
			new Notice("No Jupyter notebook (.ipynb) files found in your vault.");
			return;
		}

		const fileNames = files.map(f => f.path);
		const selected = await new Promise<string | null>((resolve) => {
			const modal = activeDocument.body.createDiv({cls: "jupymd-convert-modal"});
			modal.createDiv({
				cls: "jupymd-convert-label",
				text: "Select a Jupyter notebook to convert:",
			});

			const select = modal.createEl('select', {cls: "jupymd-convert-select"});
			for (const name of fileNames) {
				const option = select.createEl('option');
				option.value = name;
				option.textContent = name;
			}

			const btn = modal.createEl('button', {cls: "jupymd-convert-button"});
			btn.textContent = 'Convert';
			btn.onclick = () => {
				modal.remove();
				resolve(select.value);
			};

			const cancel = modal.createEl('button', {cls: "jupymd-convert-button jupymd-convert-cancel"});
			cancel.textContent = 'Cancel';
			cancel.onclick = () => {
				modal.remove();
				resolve(null);
			};
		});

		if (!selected) return;
		const file = files.find(f => f.path === selected);
		if (!file) return;

		const absPath = getAbsolutePath(file);
		const mdPath = absPath.replace(/\.ipynb$/, ".md");

		try {
			await runJupytext(this.pythonPath, ["--to", "markdown", absPath]);
			await runJupytext(this.pythonPath, ["--set-formats", "ipynb,md", absPath]);

			new Notice(`Note created and paired: ${mdPath}`);

			const mdRelative = this.app.vault.getFiles().find(
				f => getAbsolutePath(f) === mdPath
			);

			if (mdRelative) {
				await this.app.workspace.openLinkText(mdRelative.path, '', true);
			}
		} catch (error) {
			new Notice(`Failed to convert notebook: ${getErrorMessage(error)}`);
		}
	}

	async createNotebook(refreshView: boolean = true): Promise<boolean> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active note found.");
			return false;
		}

		const mdPath = getAbsolutePath(activeFile);
		const ipynbPath = mdPath.replace(/\.md$/, ".ipynb");

		if (await isNotebookPaired(this.app, activeFile)) {
			new Notice("Notebook is already paired with this note.");
			return true;
		}

		try {
			if (fs.existsSync(ipynbPath)) {
				fs.unlinkSync(ipynbPath)
			}

			await runJupytext(this.pythonPath, ["--to", "notebook", mdPath]);

			const metadata = JSON.stringify({
				kernelspec: {
					display_name: "Python 3",
					language: "python",
					name: "python3",
				},
			});

			await runJupytext(this.pythonPath, [
				ipynbPath,
				"--set-formats", "ipynb,md",
				"--update-metadata", metadata,
			]);

			if (refreshView) {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const leaf = this.app.workspace.getLeavesOfType(
					view?.getViewType() ?? ""
				)[0];

				(leaf as RebuildableWorkspaceLeaf).rebuildView?.();
			}

			new Notice(`Notebook created and paired: ${ipynbPath}`);
			return true;
		} catch (error) {
			new Notice(`Failed to create notebook: ${getErrorMessage(error)}`);
			return false;
		}
	}

	async openNotebookInEditor(editor: string) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active note found.");
			return;
		}

		if (!(await isNotebookPaired(this.app, activeFile))) {
			return;
		}

		const mdPath = getAbsolutePath(activeFile);
		const ipynbPath = mdPath.replace(/\.md$/, ".ipynb");

		const command = `${editor} "${ipynbPath}"`;

		exec(command, (error) => {
			if (error) {
				new Notice(
					`Failed to open notebook in editor: ${error.message}`
				);
				console.error(error)
				return;
			}
			new Notice(`Opened notebook in editor: ${ipynbPath}`);
		});
	}

	async syncFiles(file: TFile) {
		if (!(await isNotebookPaired(this.app, file))) return;

		const filePath = getAbsolutePath(file);
		const ipynbPath = filePath.replace(/\.md$/, ".ipynb");

		try {
			// `--sync` updates the paired notebook from markdown changes while preserving
			// existing notebook outputs instead of recreating the .ipynb from scratch.
			await runJupytext(this.pythonPath, ["--sync", ipynbPath]);
		} catch (error) {
			console.error(`Failed to sync Markdown file: ${getErrorMessage(error)}`);
		}
	}
}
