// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StatusBadge } from './GoalLeaderMatrix';

afterEach(cleanup);
it('exposes pending positive result as validation rather than completed success', () => {
  render(<StatusBadge status="pending" />);
  expect(screen.getByText('На проверке УОР')).toBeTruthy();
  expect(screen.queryByText('Подтверждено')).toBeNull();
});
it('renders missing data explicitly instead of a zero progress value', () => {
  render(<StatusBadge status="unknown" />);
  expect(screen.getByText('Нет данных')).toBeTruthy();
  expect(screen.queryByText('0%')).toBeNull();
});
