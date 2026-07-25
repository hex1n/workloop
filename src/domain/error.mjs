// One error type for the domain, in its own module so that the service layer
// and the receipt adapter can both raise it without importing each other.
export class LoopError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoopError";
    this.code = code;
  }
}

export const refuse = (code, message) => {
  throw new LoopError(code, message);
};
