const canonicalDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.(?:\d*[1-9]))?$/;

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export class DecimalAmount {
  readonly coefficient: bigint;
  readonly scale: number;

  private constructor(coefficient: bigint, scale: number) {
    let normalizedCoefficient = coefficient;
    let normalizedScale = scale;

    while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
      normalizedCoefficient /= 10n;
      normalizedScale -= 1;
    }

    if (normalizedCoefficient === 0n) {
      normalizedScale = 0;
    }

    this.coefficient = normalizedCoefficient;
    this.scale = normalizedScale;
  }

  static parse(value: string): DecimalAmount {
    if (!canonicalDecimalPattern.test(value) || value === "-0") {
      throw new Error(`Invalid canonical decimal: ${value}`);
    }

    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole = "0", fraction = ""] = unsigned.split(".");
    const coefficient = BigInt(`${negative ? "-" : ""}${whole}${fraction}`);

    return new DecimalAmount(coefficient, fraction.length);
  }

  compare(other: DecimalAmount): -1 | 0 | 1 {
    const scale = Math.max(this.scale, other.scale);
    const left = this.coefficient * powerOfTen(scale - this.scale);
    const right = other.coefficient * powerOfTen(scale - other.scale);

    if (left < right) {
      return -1;
    }

    if (left > right) {
      return 1;
    }

    return 0;
  }

  subtract(other: DecimalAmount): DecimalAmount {
    const scale = Math.max(this.scale, other.scale);
    const left = this.coefficient * powerOfTen(scale - this.scale);
    const right = other.coefficient * powerOfTen(scale - other.scale);

    return new DecimalAmount(left - right, scale);
  }

  toString(): string {
    if (this.scale === 0) {
      return this.coefficient.toString();
    }

    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient)
      .toString()
      .padStart(this.scale + 1, "0");
    const splitAt = digits.length - this.scale;
    const value = `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;

    return negative ? `-${value}` : value;
  }
}
