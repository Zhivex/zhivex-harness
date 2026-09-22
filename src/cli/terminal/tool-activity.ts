/** A bounded activity line; transcript entries are committed only at message boundaries. */
export class ToolActivity {
  private completed = 0;
  private active = 0;
  private visible = false;
  private dirty = false;
  private reads = 0;
  private searches = 0;
  private other = 0;

  constructor(private write: (text: string) => void, private tty: boolean,
    private columns: () => number = () => 80) {}

  start() { this.active++; this.dirty = true; this.render(); }
  finish(name: string) {
    this.active = Math.max(0, this.active - 1);
    this.completed++;
    if (["read_file", "read_files"].includes(name)) this.reads++;
    else if (["search_files", "search_many"].includes(name)) this.searches++;
    else this.other++;
    this.dirty = true;
    this.render();
  }
  private line() {
    return `tools · ${this.completed} completed` +
      (this.active ? ` · ${this.active} running` : "") +
      ` · ${this.reads} reads · ${this.searches} searches · ${this.other} other`;
  }
  private render() {
    if (!this.tty) return;
    if (!this.visible) this.write("\n");
    this.write(`\r\x1b[2K${this.line().slice(0, Math.max(1, this.columns() - 1))}`);
    this.visible = true;
  }
  flush() {
    if (!this.dirty) return;
    this.write(this.visible ? "\n" : `\n${this.line()}\n`);
    this.completed = this.reads = this.searches = this.other = 0;
    this.visible = this.dirty = false;
  }
}
