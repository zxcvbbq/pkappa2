import { defineStore } from "pinia";
import axios from "axios";
import APIClient from "@/apiClient";
import { StreamData } from "@/apiClient";

interface State {
  requestId: number;
  id: number | null;
  running: boolean;
  error: string | null;
  stream: StreamData | null;
}

export const useStreamStore = defineStore("stream", {
  state: (): State => ({
    requestId: 0,
    id: null,
    running: false,
    error: null,
    stream: null,
  }),
  actions: {
    async fetchStream(id: number, converter: string) {
      const requestId = ++this.requestId;
      this.id = id;
      this.running = true;
      this.error = null;
      this.stream = null;
      return APIClient.getStream(id, converter)
        .then((data) => {
          if (requestId !== this.requestId) return;
          this.id = id;
          this.error = null;
          this.stream = data;
        })
        .catch((err: unknown) => {
          if (requestId !== this.requestId || axios.isCancel(err)) return;
          if (axios.isAxiosError<string, unknown>(err)) {
            this.id = id;
            this.error =
              err.response !== undefined && err.response.data !== ""
                ? err.response.data
                : err.message;
            this.stream = null;
          } else throw err;
        })
        .finally(() => {
          if (requestId === this.requestId) this.running = false;
        });
    },
  },
});
