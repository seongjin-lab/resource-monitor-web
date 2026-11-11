import { useState } from 'react';
import { saveInterval, useLive } from '../live';
import { toast } from './Common';

export function RefreshInterval() {
  const { settings, intervalChoices } = useLive();
  const [pending, setPending] = useState<number | null>(null);
  if (!settings || intervalChoices.length === 0) return null;

  const changeInterval = async (seconds: number) => {
    setPending(seconds);
    try {
      await saveInterval(seconds);
      toast(`갱신 주기를 ${seconds}초로 변경했습니다.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : '갱신 주기를 변경하지 못했습니다.', 'error');
    } finally {
      setPending(null);
    }
  };

  return (
    <label className="refresh-interval" title="모든 서버에 적용되는 수집 주기">
      갱신 주기
      <select value={pending ?? settings.intervalSeconds} disabled={pending !== null}
        onChange={(event) => void changeInterval(Number(event.target.value))}>
        {intervalChoices.map((seconds) => <option key={seconds} value={seconds}>{seconds}초</option>)}
      </select>
    </label>
  );
}
