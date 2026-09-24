/** Ephemeral TTY status. Tool bookkeeping never becomes conversation text. */
export class ToolActivity {
  private active = 0;
  private visible = false;
  private label = "Working";

  constructor(private write: (text: string) => void, private tty: boolean,
    private columns: () => number = () => 80) {}

  start(name?: string) {
    this.active++;
    this.label = ["read_file", "read_files"].includes(name ?? "") ? "Reading files"
      : ["search_files", "search_many", "list_files"].includes(name ?? "") ? "Exploring the project"
      : name === "run_check" ? "Running checks" : "Working";
    this.render();
  }
  finish(_name: string) {
    this.active = Math.max(0, this.active - 1);
    this.label = this.active ? this.label : "Thinking";
    this.render();
  }
  private render() {
    if (!this.tty) return;
    if (!this.visible) this.write("\n");
    this.write(`\r\x1b[2K${`${this.label}…`.slice(0, Math.max(1, this.columns() - 1))}`);
    this.visible = true;
  }
  flush() {
    if (this.visible) this.write("\r\x1b[2K");
    this.visible = false;
  }
}
