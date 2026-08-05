class HostTriggerOperationQueue {
  constructor() {
    this.pending = Promise.resolve();
  }

  enqueue(operation) {
    const current = this.pending
      .catch(() => undefined)
      .then(() => operation());

    this.pending = current;
    return current;
  }
}

module.exports = HostTriggerOperationQueue;
