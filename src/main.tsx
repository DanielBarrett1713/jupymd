import {Plugin, TFile, TAbstractFile, MarkdownView, Notice, setTooltip, WorkspaceLeaf} from "obsidian";
import {JupyMDSettingTab} from "./components/Settings";
import {CodeExecutor} from "./components/CodeExecutor";
import {FileSync} from "./components/FileSync";
import {KernelSelectorModal} from "./components/KernelSelector";
import {DEFAULT_SETTINGS, JupyMDPluginSettings} from "./components/types";
import {registerCommands} from "./commands";
import {createRoot} from "react-dom/client";
import {PythonCodeBlock} from "./components/CodeBlock";
import {getAbsolutePath, isNotebookPaired} from "./utils/helpers";
import {formatKernelLabel, getInterpreterInfo} from "./utils/kernelDiscovery";
import {getDefaultPythonPath} from "./utils/pythonPathUtils";
import * as fs from "fs";
import * as path from "path";

type RebuildableWorkspaceLeaf = WorkspaceLeaf & {
	rebuildView?: () => void;
};

export default class JupyMDPlugin extends Plugin {
	settings: JupyMDPluginSettings;
	executor: CodeExecutor;
	fileSync: FileSync;
	currentNotePath: string | null = null;
	private kernelStatusBarItem : HTMLElement;
	private settingTab : JupyMDSettingTab;

	onload(): void {
		void this.initialize().catch((error) => {
			console.error("Failed to load JupyMD:", error);
			new Notice("Failed to load JupyMD, check console for details.");
		});
	}

	private async initialize(): Promise<void> {
		await this.loadSettings();

		if (!this.settings.pythonInterpreter) {
			this.settings.pythonInterpreter = getDefaultPythonPath();
			await this.saveSettings();
		}

		this.executor = new CodeExecutor(this, this.settings.pythonInterpreter, this.app);
		this.fileSync = new FileSync(this.app, this.settings.pythonInterpreter, this.settings);

		this.kernelStatusBarItem = this.addStatusBarItem();
		this.kernelStatusBarItem.addClass("kernel-status");
		void this.updateStatusBar();
		this.registerDomEvent(this.kernelStatusBarItem, "click", (event: MouseEvent) => {
			void this.handleKernelStatusBarClick(event);
		});

		registerCommands(this);

		this.settingTab = new JupyMDSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && this.settings.autoSync) {
					void this.fileSync.handleSync(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					try {
						const mdPath = getAbsolutePath(file);
						const ipynbPath = mdPath.replace(/\.md$/, ".ipynb");
						if (fs.existsSync(ipynbPath)) {
							fs.unlinkSync(ipynbPath);
						}

					} catch (e) {
						console.error("Failed to delete paired notebook:", e);
					}
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile && file.extension === "md") {
					try {
						const newMdPath = getAbsolutePath(file);
						const oldMdPath = newMdPath.substring(0, newMdPath.length - file.path.length) + oldPath;

						const oldIpynbPath = oldMdPath.replace(/\.md$/, ".ipynb");
						const newIpynbPath = newMdPath.replace(/\.md$/, ".ipynb");

						if (fs.existsSync(oldIpynbPath)) {
							fs.renameSync(oldIpynbPath, newIpynbPath);

							this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
								const view = leaf.view;
								if (view instanceof MarkdownView && view.file?.path === file.path) {
									(leaf as RebuildableWorkspaceLeaf).rebuildView?.();
								}
							});
						}
					} catch (e) {
						console.error("Failed to rename paired notebook:", e);
					}
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				void this.updateStatusBar();
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path === file.path) {
					void this.updateStatusBar();
				}
			})
		);

		if (this.settings.enableCodeBlocks) {
			this.registerMarkdownCodeBlockProcessor(
				"python",
				async (source, el, ctx) => {
					el.empty();
					const reactRoot = el.createDiv();
					const root = createRoot(reactRoot);

					const activeFile = this.app.vault.getFileByPath(ctx.sourcePath);
					const renderCodeBlock = (filePath?: string, index: number = 0) => {
						root.render(
							<PythonCodeBlock
								code={source}
								path={filePath}
								index={index}
								executor={this.executor}
								plugin={this}
							/>
						);
					};

					let index = 0;
					if (activeFile instanceof TFile) {
						const filePath = getAbsolutePath(activeFile);
						try {
							const fileContent = await this.app.vault.read(activeFile);
							const lines = fileContent.split("\n");
							let blockCount = 0;
							let foundCurrentBlock = false;

							const sectionInfo = ctx.getSectionInfo(el);
							if (!sectionInfo) {
								renderCodeBlock(filePath);
								return;
							}

							for (let i = 0; i < lines.length; i++) {
								const line = lines[i].trim();
								if (line.startsWith("```python")) {
									if (i < sectionInfo.lineStart) {
										blockCount++;
									} else if (i === sectionInfo.lineStart) {
										foundCurrentBlock = true;
										break;
									}
								}
							}

							if (foundCurrentBlock) {
								index = blockCount;
							}
						} catch (error) {
							console.error("Failed to resolve Python code block position:", error);
						}

						renderCodeBlock(filePath, index);
					} else {
						renderCodeBlock();
					}
				}
			);
		}
	}

	onunload(): void {
		this.executor.cleanup();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async formatInterpreterForStatusBar(interpreter: string): Promise<string> {
		const info = await getInterpreterInfo(this.app, interpreter);
		if (info) {
			return formatKernelLabel(info.label, info.version);
		}

		return path.basename(interpreter) || interpreter;
	}

	private async updateStatusBar(): Promise<void> {
		if (!this.kernelStatusBarItem) return;

		const activeFile = this.app.workspace.getActiveFile();
		if (!(activeFile instanceof TFile)) {
			this.kernelStatusBarItem.hide();
			return;
		}

		const isPaired = await isNotebookPaired(this.app, activeFile);
		if (!isPaired) {
			this.kernelStatusBarItem.hide();
			return;
		}

		const interpreter = this.settings.pythonInterpreter ? this.settings.pythonInterpreter : "No interpreter";
		const statusText = await this.formatInterpreterForStatusBar(interpreter);
		this.kernelStatusBarItem.show();
		this.kernelStatusBarItem.setText(statusText);
		setTooltip(this.kernelStatusBarItem, `Current Python interpreter: ${interpreter}\nClick to change interpreter\nShift + click to copy path`, {placement: "top"});
		
	}

	private async handleKernelStatusBarClick(event: MouseEvent): Promise<void> {
		if (!event.shiftKey) {
			this.openKernelSelector();
			return;
		}

		const interpreter = this.settings.pythonInterpreter;
		if (!interpreter) {
			new Notice("No interpreter path to copy");
			return;
		}

		try {
			await navigator.clipboard.writeText(interpreter);
			new Notice("Interpreter path copied");
		} catch (error) {
			console.error("Failed to copy interpreter path:", error);
			new Notice("Failed to copy interpreter path");
		}
	}

	async updateInterpreter(newPath: string): Promise<void> {
		this.settings.pythonInterpreter = newPath;
		await this.saveSettings();

		await this.executor.setPythonInterpreter(newPath);
		this.fileSync = new FileSync(this.app, newPath, this.settings);

		await this.updateStatusBar();
		this.settingTab?.display();
	}

	openKernelSelector(): void {
		new KernelSelectorModal(this.app, this).open();
	}
}
