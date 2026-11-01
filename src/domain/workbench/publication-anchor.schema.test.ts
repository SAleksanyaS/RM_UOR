import { expect, it } from 'vitest';
import { publicationAnchorSchema } from './schemas';
import { fixtureId, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';

it('publication anchor identity is the package identity for confirmed and unconfirmed anchors', () => {
  const valid = makePublicationAnchor({ id: fixtureId(910001), packageId: fixtureId(910001) });
  expect(publicationAnchorSchema.parse(valid)).toEqual(valid);
  expect(() => publicationAnchorSchema.parse({ ...valid, packageId: fixtureId(910002) })).toThrow();
  expect(() => publicationAnchorSchema.parse({ ...valid, packageId: fixtureId(910002), publicationState: 'unconfirmed', timeVerification: 'unknown', mainCommit: null, mergedAt: null, verifiedAt: null })).toThrow();
});
