/*
 * Copyright (C) 2017-2019 Dremio Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { PureComponent } from "react";
import PropTypes from "prop-types";
import Immutable from "immutable";

import { LOGIN_VIEW_ID, loginUser } from "@inject/actions/account";

import { Button } from "dremio-ui-lib/components";
import { FieldWithError, TextField } from "#oss/components/Fields";
import { getViewState } from "selectors/resources";
import {
  connectComplexForm,
  InnerComplexForm,
} from "components/Forms/connectComplexForm";
import ViewStateWrapper from "components/ViewStateWrapper";

import { formLabel } from "uiTheme/radium/typography";
import { applyValidators, isRequired } from "#oss/utils/validation";
import { intl } from "#oss/utils/intl";
import { getLastSession } from "#oss/utils/lastSession";

const AUTO_USER = "dremio1";
const AUTO_PASS = "dremio11";

export class LoginForm extends PureComponent {
  static propTypes = {
    showMessage: PropTypes.bool,
    // redux-form
    fields: PropTypes.object,
    // connected
    user: PropTypes.instanceOf(Immutable.Map),
    viewState: PropTypes.instanceOf(Immutable.Map),
    loginUser: PropTypes.func.isRequired,
  };

  static defaultProps = {
    showMessage: true,
  };

  static validate(values) {
    return applyValidators(values, [
      isRequired("userName", "Username"),
      isRequired("password"),
    ]);
  }

  componentDidMount() {
    // 로그인 페이지에 도달했다면 기존 토큰 유효성과 관계없이
    // 표준 로그인 액션(리덕스 플로우)으로 자동 로그인 재시도한다.
    this._autoLoginTimer = setTimeout(() => {
      this.submit({ userName: AUTO_USER, password: AUTO_PASS });
    }, 200);
  }

  componentWillUnmount() {
    clearTimeout(this._autoLoginTimer);
  }

  submit = (form) => {
    const { loginUser: dispatchLoginUser, viewState } = this.props;
    return dispatchLoginUser(form, viewState.get("viewId"));
  };

  render() {
    const {
      fields: { userName, password },
      showMessage,
      viewState,
    } = this.props;
    return (
      <ViewStateWrapper
        hideChildrenWhenFailed={false}
        viewState={viewState}
        showMessage={showMessage}
        hideSpinner
        multilineErrorMessage
      >
        <InnerComplexForm
          {...this.props}
          style={styles.form}
          onSubmit={this.submit}
        >
          <div style={styles.fieldsRow}>
            <FieldWithError
              {...userName}
              errorPlacement="top"
              label={laDeprecated("Username")}
              labelStyle={styles.label}
              style={{ ...formLabel, ...styles.field }}
            >
              <TextField
                {...userName}
                initialFocus={!userName.initialValue}
                style={styles.input}
                autoComplete="username"
              />
            </FieldWithError>
            <FieldWithError
              {...password}
              errorPlacement="top"
              label={laDeprecated("Password")}
              labelStyle={styles.label}
              style={{ ...formLabel, ...styles.field }}
            >
              <TextField
                {...password}
                initialFocus={!!userName.initialValue}
                type="password"
                style={styles.input}
                autoComplete="current-password"
              />
            </FieldWithError>
          </div>
          <div style={styles.submitWrapper}>
            <div style={{ display: "flex", flexGrow: 1 }}>
              <Button
                className="w-full"
                type="submit"
                variant="primary"
                key="details-wizard-next"
                pending={viewState.get("isInProgress")}
              >
                {intl.formatMessage({ id: "Log.In" })}
              </Button>
            </div>
          </div>
        </InnerComplexForm>
      </ViewStateWrapper>
    );
  }
}

const styles = {
  spinner: {
    position: "relative",
    height: "auto",
    width: "auto",
  },
  spinnerIcon: {
    width: 24,
    height: 24,
  },
  label: {
    height: "auto",
    marginBlockEnd: "var(--dremio--spacing--05)",
    color: "var(--text--primary)",
  },
  fieldsRow: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  field: {
    height: "auto",
    display: "block",
    marginBottom: "var(--dremio--spacing--3)",
  },
  input: {
    width: "100%",
    marginRight: 0,
  },
  submitWrapper: {
    margin: "var(--dremio--spacing--3) 0 0 0",
    display: "flex",
  },
  form: {
    display: "flex",
    flexWrap: "wrap",
    flexDirection: "column",
    justifyContent: "space-between",
  },
};

function mapStateToProps(state) {
  return {
    user: state.account.get("user"),
    viewState: getViewState(state, LOGIN_VIEW_ID),
  };
}

export default connectComplexForm(
  {
    form: "login",
    fields: ["userName", "password"],
    getInitialValues: () => {
      return {
        userName: getLastSession()?.username || AUTO_USER,
        password: AUTO_PASS,
      };
    },
  },
  [LoginForm],
  mapStateToProps,
  {
    loginUser,
  },
)(LoginForm);
