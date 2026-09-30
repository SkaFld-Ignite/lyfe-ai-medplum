// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the two preview decoders that ship without their own.
 *
 * Only the calls the document preview makes are declared. A wider surface would
 * be guesswork, and guessed types are worse than none: they read as checked
 * when they are not.
 */

declare module 'mammoth/mammoth.browser.js' {
  /** A message Mammoth emits about something it could not map cleanly. */
  export interface MammothMessage {
    type: string;
    message: string;
  }
  export interface MammothResult {
    /** The document as HTML. */
    value: string;
    messages: MammothMessage[];
  }
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}

declare module 'utif' {
  /** One TIFF image file directory — a page, with its decoded pixels attached. */
  export interface IFD {
    width: number;
    height: number;
    [key: string]: unknown;
  }
  /** Read the page table without decoding pixels. */
  export function decode(buffer: ArrayBuffer | Uint8Array): IFD[];
  /** Decode one page's pixels onto its IFD. */
  export function decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: IFD): void;
  /** The decoded page as RGBA bytes. */
  export function toRGBA8(ifd: IFD): Uint8Array;
  const UTIF: {
    decode: typeof decode;
    decodeImage: typeof decodeImage;
    toRGBA8: typeof toRGBA8;
  };
  export default UTIF;
}
