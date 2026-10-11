
import DPlayer from 'dplayer';

import PlayerManager from '@/services/player/PlayerManager';


/**
 * <video> 要素の映像フレームを <canvas> に高速で転写して表示する PlayerManager
 * Tesla ブラウザなど、<video> 要素をそのまま表示したくない環境向けの Canvas 描画モードで利用される
 * 音声・再生制御・デコードは従来通り <video> 要素が担当し、この PlayerManager は「見た目の映像」だけを Canvas に置き換える
 */
class CanvasRenderManager implements PlayerManager {

    // 画質切り替え時に DPlayer 側で <video> 要素が作り直されるため、画質切り替えのたびに再初期化する必要がある
    public readonly restart_required_when_quality_switched = true;

    // DPlayer のインスタンス
    // 設計上コンストラクタ以降で変更すべきでないため readonly にしている
    private readonly player: DPlayer;

    // 映像の転写先として生成した Canvas 要素 (init() 中のみ非 null)
    private canvas_element: HTMLCanvasElement | null = null;

    // Canvas 2D コンテキスト
    private context: CanvasRenderingContext2D | null = null;

    // この PlayerManager が転写元として扱っている <video> 要素
    private video_element: HTMLVideoElement | null = null;

    // <video> 要素に元々設定されていたインラインスタイル (destroy() 時に復元する)
    private original_video_style_text = '';

    // 親要素に元々設定されていた position (destroy() 時に復元する。変更しなかった場合は null)
    private original_parent_position: string | null = null;

    // requestVideoFrameCallback() / requestAnimationFrame() のハンドル (destroy() 時にキャンセルする)
    private frame_callback_handle: number | null = null;

    // 次フレームの予約に requestVideoFrameCallback() を使っているかどうか
    private is_using_video_frame_callback = false;

    // 破棄済みかどうか
    private destroyed = true;


    /**
     * コンストラクタ
     *
     * @param player DPlayer のインスタンス
     */
    constructor(player: DPlayer) {
        this.player = player;
    }


    /**
     * 現在の表示用 Canvas 要素 (L字画面クロップなど、表示要素へスタイルを当てる処理が参照する)
     * Deinterlacer の Canvas が映像を表示している間など、この Canvas が使われていない間は null を返す
     */
    public get active_canvas(): HTMLCanvasElement | null {
        if (this.canvas_element === null || this.isDeinterlacerRunning() === true) {
            return null;
        }
        return this.canvas_element;
    }


    /**
     * Canvas を生成して <video> 要素の隣に配置し、フレームの転写を開始する
     */
    public async init(): Promise<void> {

        const video = this.player.video;
        const parent = video?.parentElement;
        if (!video || !parent) {
            console.warn('[CanvasRenderManager] Video element is not available. Canvas rendering is disabled.');
            return;
        }

        // 破棄済みかどうかのフラグを下ろす
        this.destroyed = false;
        this.video_element = video;

        // 映像表示用の Canvas を生成
        // 不透明な Canvas かつ desynchronized (低遅延描画) を指定することで、描画コストと遅延を最小限にする
        const canvas = document.createElement('canvas');
        canvas.className = 'dplayer-video konomitv-canvas-video';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.objectFit = 'contain';
        // クリックやタッチは <video> と同様、親の DPlayer コンテナ側のイベントハンドラーに任せる
        canvas.setAttribute('aria-hidden', 'true');
        const context = canvas.getContext('2d', {alpha: false, desynchronized: true});
        if (context === null) {
            console.warn('[CanvasRenderManager] Failed to get 2D context. Canvas rendering is disabled.');
            this.destroyed = true;
            return;
        }
        this.canvas_element = canvas;
        this.context = context;

        // <video> 要素は音声再生とデコードのために DOM に残したまま、見えない状態にする
        // display: none や visibility: hidden だとブラウザによってはデコードが止まるため、opacity: 0 と絶対配置で退避させる
        // 絶対配置の基準になるよう、親要素が position: static の場合のみ relative にする
        this.original_video_style_text = video.style.cssText;
        if (getComputedStyle(parent).position === 'static') {
            this.original_parent_position = parent.style.position;
            parent.style.position = 'relative';
        }
        video.style.position = 'absolute';
        video.style.top = '0';
        video.style.left = '0';
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.opacity = '0';
        video.style.pointerEvents = 'none';

        // <video> 要素の直後に Canvas を挿入する
        video.insertAdjacentElement('afterend', canvas);

        // フレームの転写を開始する
        this.is_using_video_frame_callback = typeof video.requestVideoFrameCallback === 'function';
        this.scheduleNextFrame();

        console.log(`[CanvasRenderManager] Initialized. (requestVideoFrameCallback: ${this.is_using_video_frame_callback})`);
    }


    /**
     * 次のフレームの転写を予約する
     * requestVideoFrameCallback() が使えれば「新しい映像フレームが出たとき」だけ、
     * 使えなければ requestAnimationFrame() で毎描画タイミングに転写する
     */
    private scheduleNextFrame(): void {
        if (this.destroyed === true || this.video_element === null) {
            return;
        }
        if (this.is_using_video_frame_callback === true) {
            this.frame_callback_handle = this.video_element.requestVideoFrameCallback(() => this.renderFrame());
        } else {
            this.frame_callback_handle = requestAnimationFrame(() => this.renderFrame());
        }
    }


    /**
     * <video> の現在のフレームを Canvas に転写する
     */
    private renderFrame(): void {
        if (this.destroyed === true || this.video_element === null || this.canvas_element === null || this.context === null) {
            return;
        }

        const video = this.video_element;
        const canvas = this.canvas_element;

        // Deinterlacer (YADIF) の Canvas が映像を表示している間は、二重描画を避けるためこちらの Canvas を隠して転写を休止する
        if (this.isDeinterlacerRunning() === true) {
            canvas.style.display = 'none';
            this.scheduleNextFrame();
            return;
        }
        canvas.style.display = 'block';

        // 映像のデコード結果が未確定 (読み込み中など) のときは転写しない
        if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {

            // 映像の解像度が変わった (画質切り替え・ストリームの解像度変更など) ときだけ Canvas のサイズを合わせる
            // Canvas のサイズを代入すると描画内容がクリアされるため、変化がないときは触らない
            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
            }

            this.context.drawImage(video, 0, 0, canvas.width, canvas.height);
        }

        this.scheduleNextFrame();
    }


    /**
     * mpeg2toh264 の YADIF Deinterlacer が映像を表示中かどうかを返す
     */
    private isDeinterlacerRunning(): boolean {
        const deinterlacer = this.player.plugins.mpeg2toh264?.deinterlacer;
        return deinterlacer?.running === true;
    }


    /**
     * フレームの転写を止め、Canvas を除去して <video> 要素の表示状態を元に戻す
     */
    public async destroy(): Promise<void> {

        // 破棄済みなら何もしない
        if (this.destroyed === true) {
            return;
        }
        this.destroyed = true;

        // 予約済みのフレーム転写をキャンセル
        if (this.frame_callback_handle !== null) {
            if (this.is_using_video_frame_callback === true) {
                this.video_element?.cancelVideoFrameCallback(this.frame_callback_handle);
            } else {
                cancelAnimationFrame(this.frame_callback_handle);
            }
            this.frame_callback_handle = null;
        }

        // Canvas を除去
        this.canvas_element?.remove();

        // <video> 要素のスタイルと親要素の position を元に戻す
        // 画質切り替えで <video> 要素自体がすでに破棄されている場合でも、元の要素に対して戻すだけなので問題ない
        if (this.video_element !== null) {
            this.video_element.style.cssText = this.original_video_style_text;
            if (this.original_parent_position !== null && this.video_element.parentElement) {
                this.video_element.parentElement.style.position = this.original_parent_position;
            }
        }

        this.canvas_element = null;
        this.context = null;
        this.video_element = null;
        this.original_video_style_text = '';
        this.original_parent_position = null;

        console.log('[CanvasRenderManager] Destroyed.');
    }
}

export default CanvasRenderManager;
