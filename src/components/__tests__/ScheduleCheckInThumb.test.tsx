// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActualTimeGesture } from '../../views/schedule/ActualTimeGesture';
beforeEach(()=>{vi.useFakeTimers();HTMLElement.prototype.setPointerCapture=vi.fn();});
afterEach(()=>{cleanup();vi.useRealTimers();});
const down=(b:HTMLElement)=>fireEvent.pointerDown(b,{pointerId:1,isPrimary:true,button:0,clientX:100,clientY:100});
it('commits on release after a deliberate hold, never on pointer down',()=>{
 const action=vi.fn();render(<ActualTimeGesture label="Started" initial="2026-10-18T10:00:00Z" date="2026-10-18" timezone="UTC" onChoose={action}/>);const button=screen.getByRole('button');
 down(button);vi.advanceTimersByTime(370);expect(action).not.toHaveBeenCalled();
 fireEvent.pointerMove(button,{pointerId:1,clientX:140,clientY:100});expect(action).not.toHaveBeenCalled();
 fireEvent.pointerUp(button,{pointerId:1});expect(action).toHaveBeenCalledExactlyOnceWith('2026-10-18T10:30:00.000Z');
});
it('cancels a downward release or pointer interruption and retains a normal tap alternative',()=>{
 const action=vi.fn();render(<ActualTimeGesture label="Ended" initial="2026-10-18T10:00:00Z" date="2026-10-18" timezone="UTC" onChoose={action}/>);const button=screen.getByRole('button');
 down(button);vi.advanceTimersByTime(370);fireEvent.pointerMove(button,{pointerId:1,clientX:100,clientY:180});fireEvent.pointerUp(button,{pointerId:1});fireEvent.click(button,{detail:1});expect(action).not.toHaveBeenCalled();
 down(button);vi.advanceTimersByTime(370);fireEvent.pointerCancel(button);expect(action).not.toHaveBeenCalled();
 fireEvent.click(button,{detail:0});expect(screen.getByLabelText('Actual end')).toBeInTheDocument();expect(action).not.toHaveBeenCalled();
});
it('does not turn a scroll-like movement before activation into a check-in',()=>{
 const action=vi.fn();render(<ActualTimeGesture label="Started" initial="2026-10-18T10:00:00Z" date="2026-10-18" timezone="UTC" onChoose={action}/>);const button=screen.getByRole('button');
 down(button);fireEvent.pointerMove(button,{pointerId:1,clientX:102,clientY:125});vi.advanceTimersByTime(500);fireEvent.pointerUp(button,{pointerId:1});fireEvent.click(button,{detail:1});expect(action).not.toHaveBeenCalled();
});
