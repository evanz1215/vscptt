/** Runs tasks strictly one at a time, in call order. A failing task never blocks the ones behind it. */
export class CommandQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}
