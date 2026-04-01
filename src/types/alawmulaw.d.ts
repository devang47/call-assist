declare module "alawmulaw" {
  export const mulaw: {
    decode(samples: Uint8Array): Int16Array;
    encode(samples: Int16Array): Uint8Array;
  };
  export const alaw: {
    decode(samples: Uint8Array): Int16Array;
    encode(samples: Int16Array): Uint8Array;
  };
}
