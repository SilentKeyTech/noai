// SPDX-License-Identifier: MIT OR Apache-2.0
// Runs on the audio thread. Hands each block of microphone samples to the page, unchanged.
// It has no network access and sends nothing anywhere.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('noai-pcm-tap', PcmTap);
