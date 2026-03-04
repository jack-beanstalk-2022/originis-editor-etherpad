export type SocketClientRequest = {
    session: {
        user: {
            username: string;
            readOnly?: boolean;
            padAuthorizations?: {
                [key: string]: string;
            };
            /** Set by Firebase auth; when present, author name is locked to this email. */
            email?: string;
            name?: string;
            is_admin?: boolean;
        }
    }
}


export type PadUserInfo = {
    data: {
        userInfo: {
            name: string|null;
            colorId: string;
        }
    }
}


export type ChangesetRequest = {
    data: {
        granularity: number;
        start: number;
        requestID: string;
    }
}
