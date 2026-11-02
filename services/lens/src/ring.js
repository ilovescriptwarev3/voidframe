export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }

  push(item) {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  get length() {
    return this.size;
  }

  toArray() {
    const out = new Array(this.size);
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      out[i] = this.items[(start + i) % this.capacity];
    }
    return out;
  }
}
