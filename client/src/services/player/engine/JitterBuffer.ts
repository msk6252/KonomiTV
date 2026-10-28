
/**
 * ライブ/録画でバッファリング方針 (プロファイル) を分離するための設定値
 * Phase 1 は録画視聴のみのため "Recorded" プロファイルだけが実際に使われる
 * ("Live" は Phase 3 (mpegts.js 経路) 着手時に値を調整する前提の仮値)
 */
export interface JitterBufferProfile {
    /** VideoPipeline が保持する提示待ちフレームの最大枚数 */
    videoQueueFrames: number;
}

const RECORDED_PROFILE: JitterBufferProfile = {
    // 30fps 想定で約6秒分 (1セグメント分程度): 録画は安定性優先で多少の余裕を持たせる
    videoQueueFrames: 180,
};

const LIVE_PROFILE: JitterBufferProfile = {
    // 低遅延優先で短めにしつつも、デコードエラーからの自動復旧 (VideoPipeline.ts) やネットワークジッターで
    // 一時的に decode() が詰まった後、バックログがまとめて (リアルタイムより速く) デコードされてキューに
    // 押し込まれるケースを吸収できるよう、30fps 換算で約2秒分の余裕を持たせる
    // (MediaClock.ts の壁時計先走り防止策と合わせて、この余裕分が「本来まだ必要なフレーム」を
    // 誤って破棄してしまう二次被害を避けるためのバッファになる)
    videoQueueFrames: 60,
};

class JitterBuffer {
    public static getProfile(playbackMode: 'Live' | 'Recorded'): JitterBufferProfile {
        return playbackMode === 'Recorded' ? RECORDED_PROFILE : LIVE_PROFILE;
    }
}

export default JitterBuffer;
