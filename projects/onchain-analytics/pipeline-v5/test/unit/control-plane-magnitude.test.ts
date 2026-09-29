/**
 * Magnitude tripwires.
 *
 * Every band below is proven in BOTH directions: green on a value the chain really produces, red
 * on the shape a wrong decode really produces. A tripwire that only ever passes is not a tripwire,
 * and this file is the proof that none of these is one.
 *
 * The values are not invented. 1000 GD is the measured inviter bounty on all 939 rows in the
 * warehouse; 74 to 333 GD is the measured range of a Celo daily claim; `4` is the exact value a
 * reversed union ABI returns for `balance`, being the byte length of the string "celo".
 */

import { describe, it, expect } from "vitest";
import { checkMagnitude, checkRowMagnitudes, bandFor, MAGNITUDE_BANDS } from "../../src/control-plane/magnitude.js";

const GD_18 = 18;
const GD_2 = 2;
const gd = (whole: number) => BigInt(whole) * 10n ** 18n;

describe("every consumed numeric field has a band", () => {
  it("covers the three numeric fields the consumed events carry", () => {
    // UBIClaimed, InviteeJoined and InviterBounty are the consumed events. InviteeJoined carries
    // two addresses and no numeric parameter, so three fields need a band, not three events'.
    expect(MAGNITUDE_BANDS.map((b) => b.field).sort()).toEqual([
      "InviterBounty.bountyPaid", "InviterBounty.inviterLevel", "UBIClaimed.amount",
    ]);
    for (const b of MAGNITUDE_BANDS) expect(b.why.length).toBeGreaterThan(40);
  });

  it("refuses to check a field nobody declared a band for", () => {
    expect(() => checkMagnitude("UBIClaimed.somethingNew", 1n, 18)).toThrow(/no band declared/);
    expect(bandFor("UBIClaimed.somethingNew")).toBeUndefined();
  });

  it("refuses an implausible decimals argument rather than scaling by it", () => {
    expect(() => checkMagnitude("UBIClaimed.amount", gd(300), -1)).toThrow(/implausible token decimals/);
    expect(() => checkMagnitude("UBIClaimed.amount", gd(300), 99)).toThrow(/implausible token decimals/);
  });
});

describe("UBIClaimed.amount", () => {
  it("GREEN on a real claim", () => {
    for (const amount of [74, 150, 333]) {
      const v = checkMagnitude("UBIClaimed.amount", gd(amount), GD_18);
      expect(v.plausible).toBe(true);
      expect(v.humanValue).toBe(amount);
    }
  });

  /*
   * THE CASE THIS EXISTS FOR. A reversed union ABI decodes an era-2 log against the era-1 layout
   * and returns the string's byte length as the amount. It does not throw, and every structural
   * test passes. 4 raw units of an 18-decimal token is 4e-18 GD, which is not a quantity anybody
   * transacts -- and that is the only thing left to notice.
   */
  it("RED on a raw 4, which is what a reversed union ABI returns", () => {
    const v = checkMagnitude("UBIClaimed.amount", 4n, GD_18);
    expect(v.plausible).toBe(false);
    expect(v.outcome).toBe("below_raw_floor");
    expect(v.detail).toContain("wrong-layout decode");
  });

  it("RED when the scale factor is missing entirely", () => {
    // The raw value published as if it were already scaled: 3e20 GD.
    const v = checkMagnitude("UBIClaimed.amount", gd(300), 0);
    expect(v.plausible).toBe(false);
    expect(v.outcome).toBe("above_max");
  });

  it("RED when the token's decimals are read from the wrong chain", () => {
    // GD is 18 decimals on Celo and XDC but 2 on Fuse and Ethereum. Scaling a Celo amount by the
    // Fuse factor is a real, available mistake, and it is caught.
    const v = checkMagnitude("UBIClaimed.amount", gd(300), GD_2);
    expect(v.plausible).toBe(false);
    expect(v.outcome).toBe("above_max");
  });

  it("RED on zero, which a claim never is", () => {
    expect(checkMagnitude("UBIClaimed.amount", 0n, GD_18).outcome).toBe("below_min");
  });
});

describe("InviterBounty.bountyPaid", () => {
  it("GREEN on the measured 1000 GD bounty", () => {
    const v = checkMagnitude("InviterBounty.bountyPaid", gd(1000), GD_18);
    expect(v.plausible).toBe(true);
    expect(v.humanValue).toBe(1000);
  });

  it("GREEN on a level-based bonus well above it, because the band is not a policy", () => {
    expect(checkMagnitude("InviterBounty.bountyPaid", gd(5000), GD_18).plausible).toBe(true);
  });

  it("RED when the 1e18 divide is missing", () => {
    const v = checkMagnitude("InviterBounty.bountyPaid", gd(1000), 0);
    expect(v.plausible).toBe(false);
    expect(v.outcome).toBe("above_max");
  });

  it("RED on a raw value too small to be a bounty", () => {
    expect(checkMagnitude("InviterBounty.bountyPaid", 4n, GD_18).outcome).toBe("below_raw_floor");
  });
});

describe("InviterBounty.inviterLevel", () => {
  it("GREEN on the measured level 0, and on a plausible higher level", () => {
    expect(checkMagnitude("InviterBounty.inviterLevel", 0n, GD_18).plausible).toBe(true);
    expect(checkMagnitude("InviterBounty.inviterLevel", 7n, GD_18).plausible).toBe(true);
  });

  it("is NOT decimals-scaled, because a level is an ordinal and not a token amount", () => {
    // Passing 18 or 2 makes no difference: an index into the contract's levels array has no scale.
    expect(checkMagnitude("InviterBounty.inviterLevel", 3n, GD_18).humanValue).toBe(3);
    expect(checkMagnitude("InviterBounty.inviterLevel", 3n, GD_2).humanValue).toBe(3);
  });

  it("RED on a token-shaped value, which is what reading the wrong word gives", () => {
    const v = checkMagnitude("InviterBounty.inviterLevel", gd(1000), GD_18);
    expect(v.plausible).toBe(false);
    expect(v.outcome).toBe("above_max");
  });

  it("RED on an address-shaped value", () => {
    const addressShaped = BigInt("0x603b8c0f110e037b51a381cbcacabb8d6c6e4543");
    expect(checkMagnitude("InviterBounty.inviterLevel", addressShaped, GD_18).plausible).toBe(false);
  });
});

describe("a whole decoded row is checked at once", () => {
  it("returns nothing when every field is plausible, so an empty result IS the pass", () => {
    expect(checkRowMagnitudes([
      { field: "UBIClaimed.amount", rawValue: gd(300), decimals: GD_18 },
      { field: "InviterBounty.bountyPaid", rawValue: gd(1000), decimals: GD_18 },
      { field: "InviterBounty.inviterLevel", rawValue: 0n, decimals: GD_18 },
    ])).toEqual([]);
  });

  it("names every failing field rather than stopping at the first", () => {
    const failures = checkRowMagnitudes([
      { field: "UBIClaimed.amount", rawValue: 4n, decimals: GD_18 },
      { field: "InviterBounty.bountyPaid", rawValue: gd(1000), decimals: GD_18 },
      { field: "InviterBounty.inviterLevel", rawValue: gd(1), decimals: GD_18 },
    ]);
    expect(failures.map((f) => f.field)).toEqual(["UBIClaimed.amount", "InviterBounty.inviterLevel"]);
  });
});

describe("the limit of a magnitude band, stated rather than discovered later", () => {
  it("catches a large factor error always", () => {
    expect(checkMagnitude("UBIClaimed.amount", gd(300), 0).plausible).toBe(false);
  });

  it("MISSES a 1e2 error on a small value, and this is why it is a SECOND line of defence", () => {
    // A 74 GD claim read with a 1e16 factor instead of 1e18 gives 7,400 GD, which is inside the
    // band. The band is honest about what it cannot do: the first line of defence is the union
    // order and the ambiguity assertion, not this.
    const wrongFactor = checkMagnitude("UBIClaimed.amount", gd(74), 16);
    expect(wrongFactor.plausible).toBe(true);
    expect(wrongFactor.humanValue).toBe(7400);
  });
});
