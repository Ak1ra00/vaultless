const { computeEntropy } = require('../utils');

describe('computeEntropy', () => {
    it('returns a number between 0 and 100', () => {
        const val = computeEntropy(null);
        expect(typeof val).toBe('number');
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
    });
});
