
import Utils from '@/utils/Utils';


/**
 * ブラウザの開発者ツールを開いて確認することが難しい環境 (Tesla ブラウザ等) でもデバッグできるよう、
 * クライアント側で発生したエラーをサーバーログ (KonomiTV-Server.log) に転送するベストエフォートな報告関数
 *
 * この報告自体が失敗しても (サーバー未起動・ネットワーク断等) 再生そのものには一切影響を与えない
 * (必ず console.error() には出力してから、報告を試みる)
 *
 * @param context エラーが発生した機能・コンポーネント名 (ログでの絞り込み用、例: "WebCodecsPlayer/LiveVideoSource")
 * @param error 発生したエラー (Error インスタンスでなくても良い)
 */
export default function reportClientError(context: string, error: unknown): void {
    console.error(`[${context}]`, error);

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;

    void fetch(`${Utils.api_base_url}/maintenance/client-error`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            context,
            message,
            stack,
            user_agent: navigator.userAgent,
        }),
    }).catch(() => {
        // サーバーへの報告自体が失敗しても (元のエラーはすでに console.error 済みなので) 無視する
    });
}
